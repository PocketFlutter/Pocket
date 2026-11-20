import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { startEditor } from "../server.ts";

test("Studio custom viewport reaches the guest and keeps scaled canvas input aligned", { timeout: 90_000 }, async () => {
  const workspace = await mkdtemp(join(tmpdir(), "pocket-custom-viewport-"));
  const server = await startEditor({ port: 0, workspace });
  const browser = await chromium.launch({ headless: true });
  try {
    const origin = `http://127.0.0.1:${server.port}`;
    const json = { "x-pocket-editor": "1", "content-type": "application/json" };
    for (const id of ["viewport-fixture", "viewport-secondary"]) {
      const created = await fetch(`${origin}/api/projects`, {
        method: "POST",
        headers: json,
        body: JSON.stringify({ id, name: id }),
      });
      expect(created.status).toBe(201);
    }
    const source = await fetch(`${origin}/api/projects/viewport-fixture/source`, {
      method: "PUT",
      headers: json,
      body: JSON.stringify({ source: `
import { createSignal } from "solid-js";
import { mount } from "@pocketjs/framework/solid";
import { Focusable, Screen, Text, View } from "@pocketjs/framework/solid/components";
import { createDisplayGeometry } from "@pocket/ui";
function App() {
  const display = createDisplayGeometry();
  const [count, setCount] = createSignal(0);
  const facts = () => {
    const { width, height, safeArea: { top, right, bottom, left } } = display();
    return [width, height, top, right, bottom, left].join("/");
  };
  return <Screen>
    <View class="w-full h-full items-center justify-center gap-4">
      <Text>{facts()}</Text>
      <Focusable class="w-[160] h-[56] items-center justify-center bg-[#315DEB]"
        onPress={() => setCount(count() + 1)}>
        <Text>{"count=" + count()}</Text>
      </Focusable>
    </View>
  </Screen>;
}
mount(() => <App />);
` }),
    });
    expect(source.status).toBe(200);

    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.addInitScript(() => {
      window.addEventListener("message", (event) => {
        if (event.data?.source === "pocket-editor-preview" && event.data.type === "preview.frame") {
          (window as any).customViewportFrame = event.data.frame;
        }
      });
    });
    await page.goto(origin);
    const chooseProject = async (name: string) => {
      const switcher = page.locator("#project-switcher");
      if (await switcher.getAttribute("open") === null) await switcher.locator("summary").press("Enter");
      await switcher.locator(".project-item").filter({ hasText: name }).click();
      await page.waitForFunction((title) => document.querySelector("#project-title")?.textContent === title, name);
    };
    const waitForText = async (label: string) => {
      const op = await page.waitForFunction((text) =>
        (window as any).customViewportFrame?.ops.find((item: any) => item.type === "text" && item.text === text), label);
      return await op.jsonValue();
    };
    await chooseProject("viewport-fixture");
    await page.locator("#build").click();
    await waitForText("375/812/44/0/34/0");

    const dialog = page.locator("#custom-viewport-dialog");
    const edit = page.locator("#edit-custom-viewport");
    const picker = page.locator("#viewport-picker");
    const fill = (name: string, value: string) => dialog.locator(`[name="${name}"]`).fill(value);
    const apply = dialog.getByRole("button", { name: "应用" });

    await edit.click();
    expect(await dialog.locator('[name="width"]').inputValue()).toBe("375");
    await fill("width", "540");
    await fill("height", "1170");
    await fill("top", "1200");
    await apply.click();
    await dialog.getByRole("alert").waitFor();
    expect(await picker.inputValue()).toBe("mobile");
    await fill("top", "38");
    await fill("bottom", "24");
    await fill("left", "7");
    await fill("right", "9");
    await apply.click();
    await dialog.waitFor({ state: "hidden" });
    await waitForText("540/1170/38/9/24/7");
    expect(await picker.inputValue()).toBe("custom");

    const count = await waitForText("count=0") as { x: number; y: number; w: number; h: number };
    const canvas = page.frameLocator("#preview-frame").locator("canvas").first();
    const box = await canvas.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeLessThan(540);
    await page.mouse.click(
      box!.x + (count.x + count.w / 2) * box!.width / 540,
      box!.y + (count.y + count.h / 2) * box!.height / 1170,
    );
    await waitForText("count=1");

    await edit.click();
    await fill("width", "541");
    await dialog.getByRole("button", { name: "取消" }).click();
    expect(await picker.inputValue()).toBe("custom");
    await chooseProject("viewport-secondary");
    expect(await picker.inputValue()).toBe("custom");
    await chooseProject("viewport-fixture");
    await page.reload();
    await waitForText("540/1170/38/9/24/7");
    expect(await picker.inputValue()).toBe("custom");

    await picker.selectOption("mobile");
    await waitForText("375/812/44/0/34/0");
    await page.reload();
    await waitForText("375/812/44/0/34/0");
    expect(await picker.inputValue()).toBe("mobile");
    await edit.click();
    expect(await dialog.locator('[name="width"]').inputValue()).toBe("540");
  } finally {
    await browser.close();
    await server.stop(true);
    await rm(workspace, { recursive: true, force: true });
  }
});
