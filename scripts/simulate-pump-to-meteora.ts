import { simulate } from "./simulate-common";

simulate("pump-to-meteora").catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
