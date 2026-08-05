import { simulate } from "./simulate-common";

simulate("meteora-to-pump").catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
