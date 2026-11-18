/** Local end-to-end acceptance: create/open -> build real QJBC -> click Preview -> restart. */
import { strict as assert } from "node:assert";
import { cpSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { chromium } from "playwright";
import { startEditor } from "../server.ts";

const sdk = resolve(import.meta.dir, "../..");
const root = mkdtempSync(join(tmpdir(), "pocket-open-live-"));
const workspace = join(root, "workspace");
const external = join(root, "Original counter");
cpSync(join(sdk, "templates/app"), external, { recursive: true, filter: p => !p.split(/[\\/]/).includes("node_modules") });
writeFileSync(join(external, "editor.json"), JSON.stringify({ id: "opened-counter", name: "Opened counter", title: "Opened counter" }));
const pocket = JSON.parse(readFileSync(join(external, "pocket.json"), "utf8"));pocket.title="Opened counter";
writeFileSync(join(external,"pocket.json"),JSON.stringify(pocket));
const example = readFileSync(join(sdk, "../README.md"), "utf8").match(/```tsx\n([\s\S]*?)```/)!;
writeFileSync(join(external, "app.tsx"), example[1]);
const original = readFileSync(join(external,"app.tsx"),"utf8");
let server = await startEditor({ port: 0, workspace });
const browser = await chromium.launch({ headless: true, ...(process.env.POCKET_TEST_BROWSER_CHANNEL ? { channel: process.env.POCKET_TEST_BROWSER_CHANNEL } : {}) });
const errors:string[]=[];
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
page.on("pageerror", error=>errors.push(error.message));
// Isolate SDK self-update discovery; application, build and Preview routes stay real.
await page.route("**/api/studio/upgrade/check", route=>route.fulfill({json:{currentVersion:"0.1.16",status:"up-to-date"}}));
// This probe exercises the retained manual path flow; the OS dialog has separate acceptance.
await page.route("**/api/projects/pick-directory", route => route.fulfill({ json: { path: null } }));
const origin = ()=>`http://127.0.0.1:${server.port}`;
const delay=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function snapshot() {
  const response=await fetch(`${origin()}/api/projects/opened-counter/preview/snapshot`);
  return await response.json() as any;
}
async function waitFrame(text:string) {
  const deadline=Date.now()+45_000;
  while(Date.now()<deadline){
    const current=await snapshot();
    if(current.frame?.ops?.some((op:any)=>op.text===text))return current.frame;
    await delay(100);
  }
  throw new Error(`Preview did not show ${text}: ${JSON.stringify(await snapshot())}`);
}
try {
  await page.goto(origin());
  await page.locator("#new-project").click();
  const directory=join(root,"Created app's folder");
  await page.locator('#create-form [name="id"]').fill("created-app");
  await page.locator('#create-form [name="directory"]').fill(directory);
  await page.locator('#create-form [name="name"]').fill("Created app");
  await page.locator('#create-form button[type="submit"]').click();
  await page.locator("#create-dialog").waitFor({state:"hidden"});
  assert.ok(existsSync(join(directory,"package.json")));
  // A moved consumer still resolves its own cwd, including spaces and apostrophes.
  const moved=join(root,"Moved app's folder");renameSync(directory,moved);
  const child=spawn("npm",["run","build"],{cwd:moved,env:{...process.env,POCKET_SOURCE_BUILD:"1"},stdio:["ignore","pipe","pipe"]});
  let log="";child.stdout.on("data",b=>log+=b);child.stderr.on("data",b=>log+=b);
  assert.equal(await new Promise(resolve=>child.on("close",resolve)),0,log);
  assert.ok(existsSync(join(moved,"build/pocket/app.qjbc")));

  await page.locator("#open-project").click();
  await page.locator('#open-project-form [name="path"]').fill(join(root,"not-a-project"));
  await page.locator("#confirm-open-project").click();
  await page.locator("#open-project-error:not([hidden])").waitFor();
  await page.locator('#open-project-form [name="path"]').fill(external);
  await page.locator("#confirm-open-project").click();
  await page.locator("#open-project-dialog").waitFor({state:"hidden"});
  await page.locator("#build").click();
  const initial=await waitFrame("Hello Pocket · 0");
  const button=initial.ops.find((op:any)=>op.text==="+1");assert.ok(button);
  const canvas=page.frameLocator("#preview-frame").locator("canvas").first();
  await canvas.waitFor({state:"visible"});
  const box=await canvas.boundingBox();assert.ok(box);
  await page.mouse.click(box.x+(button.x+button.w/2)/initial.width*box.width,box.y+(button.y+button.h/2)/initial.height*box.height,{delay:120});
  const changed=await waitFrame("Hello Pocket · 1");assert.notDeepEqual(initial.ops,changed.ops);
  assert.equal(readFileSync(join(external,"app.tsx"),"utf8"),original);
  await page.reload();
  await page.waitForFunction(() => document.querySelector("#project-title")?.textContent === "Opened counter");
  await waitFrame("Hello Pocket · 1");
  await page.screenshot({path:"/tmp/pocket-project-open-desktop.png"});
  await page.setViewportSize({width:390,height:844});
  await page.locator("#open-project").click();
  await page.screenshot({path:"/tmp/pocket-project-open-mobile.png"});
  await page.locator("#cancel-open-project").click();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,"narrow layout overflows");
  assert.deepEqual(errors,[]);
  server.stop(true);server=await startEditor({port:0,workspace});
  const projects=await (await fetch(`${origin()}/api/projects`)).json() as any[];
  assert.ok(projects.some(p=>p.id==="opened-counter"));
  console.log("PASS: UI create/open/error, relocated npm build, actual QJBC Preview pointer 0→1, source unchanged, desktop/mobile, restart restore");
} finally {
  await browser.close();server.stop(true);rmSync(root,{recursive:true,force:true});
}
