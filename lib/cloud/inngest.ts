import { Inngest } from "inngest";
export const inngest = new Inngest({
  id: "zupe-ebay-lister",
  checkpointing: { maxRuntime: "260s" },
});
