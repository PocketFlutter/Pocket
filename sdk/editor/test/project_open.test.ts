import { expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startEditor } from "../server.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pocket-project-open-"));
  const workspace = join(root, "workspace");
  const project = (folder: string, id = "my-app") => {
    const path = join(root, folder);
    cpSync(join(import.meta.dir, "../../templates/app"), path, { recursive: true, filter: p => !p.split(/[\\/]/).includes("node_modules") });
    writeFileSync(join(path, "editor.json"), JSON.stringify({ id, name: id }));
    return path;
  };
  return { root, workspace, project };
}
async function request(server: Awaited<ReturnType<typeof startEditor>>, path: string, body?: unknown, headers?: Record<string, string>) {
  const response = await fetch(`http://127.0.0.1:${server.port}${path}`, body === undefined ? undefined : {
    method: "POST", headers: { "content-type": "application/json", "x-pocket-editor": "1", ...headers }, body: JSON.stringify(body),
  });
  return { status: response.status, data: await response.json() as any };
}

test("open edits original files, is idempotent, and restores original project bindings after restart", async () => {
  const f = fixture(); const external = f.project("Existing app");
  const before = readFileSync(join(external, "app.tsx"), "utf8");
  let server = await startEditor({ port: 0, workspace: f.workspace });
  try {
    const opened = await request(server, "/api/projects/open", { path: external });
    expect(opened.status).toBe(200);
    expect(opened.data.id).toBe("my-app");
    expect((await request(server, "/api/projects/open", { path: external })).data.id).toBe("my-app");
    expect((await request(server, "/api/projects")).data).toHaveLength(1);
    expect(readFileSync(join(external, "app.tsx"), "utf8")).toBe(before);
    expect(existsSync(join(f.workspace, "projects/my-app/app.tsx"))).toBe(false);
    const save = await fetch(`http://127.0.0.1:${server.port}/api/projects/my-app/files/app.tsx`, {
      method: "PUT", headers: { "content-type": "application/json", "x-pocket-editor": "1" }, body: JSON.stringify({ content: before + "\n// saved in place\n" }),
    });
    expect(save.status).toBe(200);
    expect(readFileSync(join(external, "app.tsx"), "utf8")).toContain("saved in place");
    server.stop(true);
    server = await startEditor({ port: 0, workspace: f.workspace });
    expect((await request(server, "/api/projects")).data.map((v: any) => v.id)).toEqual(["my-app"]);
    expect((await request(server, "/api/projects/my-app/config")).status).toBe(200);
  } finally { server.stop(true); rmSync(f.root, { recursive: true, force: true }); }
});

test("same-name projects get distinct stable IDs without overwriting either source", async () => {
  const f = fixture(); const first = f.project("first"), second = f.project("second");
  let server = await startEditor({ port: 0, workspace: f.workspace });
  try {
    const a = await request(server, "/api/projects/open", { path: first });
    const b = await request(server, "/api/projects/open", { path: second });
    expect(b.status).toBe(200); expect(a.data.id).not.toBe(b.data.id);
    server.stop(true);server = await startEditor({ port: 0, workspace: f.workspace });
    expect((await request(server, "/api/projects")).data.map((v: any) => v.id).sort()).toEqual([a.data.id,b.data.id].sort());
    expect(JSON.parse(readFileSync(join(second, "editor.json"), "utf8")).id).toBe("my-app");
  } finally { server.stop(true);rmSync(f.root,{recursive:true,force:true}); }
});

test("open accepts a Flutter consumer's js directory and rejects invalid/symlink/cross-origin paths", async () => {
  const f=fixture();const project=f.project("consumer/js");
  symlinkSync(project,join(f.root,"link"));
  const server=await startEditor({port:0,workspace:f.workspace});
  try {
    expect((await request(server,"/api/projects/open",{path:join(f.root,"consumer")})).status).toBe(200);
    for(const path of ["relative",f.root,join(f.root,"missing"),join(f.root,"link")]) {
      expect((await request(server,"/api/projects/open",{path})).status).toBe(400);
    }
    expect((await request(server,"/api/projects/open",{path:project},{origin:"https://example.com"})).status).toBe(403);
    const unsafe=f.project("unsafe","unsafe");
    rmSync(join(unsafe,"pocket.json"));symlinkSync(join(project,"pocket.json"),join(unsafe,"pocket.json"));
    expect((await request(server,"/api/projects/open",{path:unsafe})).status).toBe(400);
    expect((await request(server,"/api/projects")).data).toHaveLength(1);
  } finally {server.stop(true);rmSync(f.root,{recursive:true,force:true});}
});

test("create at an explicit directory writes runnable support files and refuses existing directories",async()=>{
  const f=fixture();const directory=join(f.root,"New game");
  const server=await startEditor({port:0,workspace:f.workspace});
  try{
    const result=await request(server,"/api/projects",{id:"new-game",name:"New game",template:"game",directory});
    expect(result.status).toBe(201);
    const pkg=JSON.parse(readFileSync(join(directory,"package.json"),"utf8"));
    for(const name of ["start","build","build:web","editor:status","editor:stop"])expect(pkg.scripts[name]).toBeString();
    expect(existsSync(join(directory,"tsconfig.json"))).toBe(true);
    expect(readFileSync(join(directory,"README.md"),"utf8")).toContain("npm start");
    expect(existsSync(join(directory,"assets"))).toBe(true);
    expect(JSON.parse(readFileSync(join(f.workspace,"opened-projects.json"),"utf8"))[0].path).toBe(realpathSync(directory));
    const keep=readFileSync(join(directory,"app.tsx"),"utf8");
    expect((await request(server,"/api/projects",{id:"other-game",directory})).status).toBe(409);
    expect(readFileSync(join(directory,"app.tsx"),"utf8")).toBe(keep);
  } finally {server.stop(true);rmSync(f.root,{recursive:true,force:true});}
});
