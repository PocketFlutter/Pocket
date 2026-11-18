import { createSignal } from "solid-js";
import { mount } from "@pocketjs/framework/solid";
import { Text, View } from "@pocketjs/framework/solid/components";
import { Button as PaperButton } from "@pocket/looseleaf";
import { Button as ArcButton } from "@pocket/arc";
import { LiquidGlassButton, LiquidGlassProvider } from "@pocket/liquid_glass";

function App() {
  const [count, setCount] = createSignal(0);
  return <LiquidGlassProvider mode="dark" accent="blue" qualityTier="balanced">
    <View class="w-full h-full flex-col gap-4 p-4">
      <Text class="text-base">{`Count ${count()}`}</Text>
      <PaperButton label="Paper increment" onPress={() => setCount(count() + 1)} />
      <ArcButton label="Arc increment" onPress={() => setCount(count() + 10)} />
      <LiquidGlassButton label="Glass increment" variant="glass" onPress={() => setCount(count() + 100)} />
    </View>
  </LiquidGlassProvider>;
}
mount(App);
