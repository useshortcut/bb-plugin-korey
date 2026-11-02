import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { ConnectionSettings } from "./connection-settings.js";
import { OPERATION_RESOLUTION_RENDERER_ID } from "./contracts.js";
import { OperationResolution } from "./operation-resolution.js";

export default definePluginApp((app) => {
  app.slots.pendingInteraction({
    id: OPERATION_RESOLUTION_RENDERER_ID,
    component: OperationResolution,
  });
  app.slots.settingsSection({
    id: "korey-account",
    title: "Korey account",
    description:
      "Sign in with Korey instead of pasting a personal access token.",
    component: ConnectionSettings,
  });
});
