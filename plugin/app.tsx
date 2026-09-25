import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { OPERATION_RESOLUTION_RENDERER_ID } from "./contracts.js";
import { OperationResolution } from "./operation-resolution.js";

export default definePluginApp((app) => {
  app.slots.pendingInteraction({
    id: OPERATION_RESOLUTION_RENDERER_ID,
    component: OperationResolution,
  });
});
