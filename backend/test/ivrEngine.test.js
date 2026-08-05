import test from "node:test";
import assert from "node:assert/strict";
import { simulateIvr, validateIvrGraph } from "../src/services/ivrEngine.js";

const graph = {
  nodes: [
    { id: "start", type: "start", data: {} },
    {
      id: "menu",
      type: "menu",
      data: {
        text: "Say sales or support",
        choices: [
          { label: "Sales", value: "sales", keywords: ["buy"] },
          { label: "Support", value: "support", keywords: ["help"] },
        ],
      },
    },
    { id: "sales", type: "speak", data: { text: "Sales" } },
    { id: "support", type: "transfer", data: { team: "support" } },
    { id: "end", type: "end", data: {} },
  ],
  edges: [
    { id: "a", source: "start", target: "menu" },
    { id: "b", source: "menu", sourceHandle: "sales", target: "sales" },
    { id: "c", source: "menu", sourceHandle: "support", target: "support" },
    { id: "d", source: "menu", sourceHandle: "default", target: "end" },
    { id: "e", source: "sales", target: "end" },
  ],
};

test("validates a connected deterministic IVR", () => {
  const result = validateIvrGraph(graph);
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test("routes spoken keywords through menu outputs", async () => {
  const result = await simulateIvr(graph, ["I need help"]);
  assert.equal(result.valid, true);
  assert.deepEqual(result.trace.map((entry) => entry.nodeId), ["start", "menu", "support"]);
});

test("rejects menu choices without connected outputs", () => {
  const broken = structuredClone(graph);
  broken.edges = broken.edges.filter((edge) => edge.sourceHandle !== "support");
  const result = validateIvrGraph(broken);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((message) => message.includes("Support")));
});
