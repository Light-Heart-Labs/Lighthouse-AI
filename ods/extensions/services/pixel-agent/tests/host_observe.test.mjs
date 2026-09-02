import test from "node:test";
import assert from "node:assert/strict";
import { createHostObserveTool, testing } from "../plugin/host-observe.mjs";

test("host observation accepts only unique fixed read-only actions", () => {
  assert.deepEqual(
    testing.normalizedActions(["host.identity", "host.kernel"]),
    ["host.identity", "host.kernel"]
  );
  assert.throws(() => testing.normalizedActions([]), /invalid host observation actions/);
  assert.throws(
    () => testing.normalizedActions(["host.identity", "host.identity"]),
    /duplicate host observation action/
  );
  assert.throws(
    () => testing.normalizedActions(["raw-shell"]),
    /invalid host observation action/
  );
});

test("host observation schema exposes no target, command, parameters, or approval input", async () => {
  const tool = createHostObserveTool();
  assert.equal(tool.name, "pixel_ods_host_observe");
  assert.deepEqual(tool.parameters.required, ["actions"]);
  assert.deepEqual(Object.keys(tool.parameters.properties), ["actions", "includeOdsStatus"]);
  assert.equal(tool.parameters.additionalProperties, false);
  assert.equal(tool.parameters.properties.actions.uniqueItems, true);
  assert.equal(tool.parameters.properties.actions.items.enum.includes("host.identity"), true);
  assert.equal(tool.parameters.properties.actions.items.enum.includes("raw-shell"), false);
  assert.deepEqual(tool.parameters.properties.includeOdsStatus, { type: "boolean" });

  const result = await tool.execute("call-1", { actions: ["raw-shell"] });
  assert.equal(result.isError, true);
  assert.deepEqual(Object.keys(result.details).sort(), ["boundaryNotice", "status"]);
  assert.doesNotMatch(result.content[0].text, /raw-shell|var\/lib|operations job ID/);
});
