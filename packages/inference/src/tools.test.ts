import { describe, expect, test } from "bun:test";
import {
  type ChatMessage,
  createNeuralwattClient,
  discoverNeuralwattModels,
  type NeuralwattModel,
  type ToolDefinition,
  wireToolCall,
} from "./index";

const model: NeuralwattModel = {
  id: "fictional-tools",
  displayName: "Fictional Tools",
  maxContextTokens: 262144,
  maxOutputTokens: 8192,
  vision: false,
  maxImages: null,
  tools: true,
  systemRole: true,
  reasoningEffort: false,
  deprecated: false,
  reasoning: null,
  pricing: {
    currency: null,
    inputPerMillion: null,
    outputPerMillion: null,
    cachedInputPerMillion: null,
    pricingTbd: true,
  },
};
const tool: ToolDefinition = {
  name: "generate_image",
  description: "Queue one fictional picture.",
  parameters: { type: "object", properties: { scene: { type: "string" } } },
};
const call = { id: "functions.generate_image:0", name: tool.name, arguments: '{"scene":"garden"}' };
const messages: ChatMessage[] = [{ role: "user", content: "A fictional picture, please." }];
const toolResponse = (calls: unknown = [wireToolCall(call)], reason = "tool_calls") =>
  Response.json({
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: calls,
          reasoning: "private trace",
        },
        finish_reason: reason,
      },
    ],
    usage: { prompt_tokens: 12, completion_tokens: 5 },
  });

describe("bounded Neuralwatt tool transport", () => {
  test("discovers tools only from explicit authenticated capability metadata", async () => {
    const catalog = await discoverNeuralwattModels({
      apiKey: "fictional-secret",
      transport: async () =>
        Response.json(
          {
            scope: "customer",
            data: [
              { id: "tools", metadata: { capabilities: { tools: true } } },
              { id: "text", metadata: { capabilities: { tools: "true" } } },
              { id: "unknown" },
            ],
          },
          { headers: { "x-models-scope": "customer" } },
        ),
    });
    expect(catalog.models.map(({ tools }) => tools)).toEqual([true, false, false]);
  });

  test("returns only allowlisted tool calls and actual usage while keeping hosted tools disabled", async () => {
    const client = createNeuralwattClient({
      apiKey: "fictional-secret",
      model: model.id,
      capabilities: model,
      transport: async (_url, init) => {
        const body = JSON.parse(String(init.body));
        expect(body.tools).toEqual([{ type: "function", function: tool }]);
        expect(body.tool_choice).toBe("auto");
        expect(new Headers(init.headers).get("X-NW-Tools-Opt-Out")).toBe("true");
        return toolResponse();
      },
    });
    const response = await client.complete({ messages, tools: [tool] });
    expect(response).toMatchObject({
      text: "",
      complete: false,
      finishReason: "tool_calls",
      toolCalls: [call],
      usage: { inputTokens: 12, outputTokens: 5 },
    });
    expect(JSON.stringify(response)).not.toContain("private trace");
  });

  test("requires pinned tool capabilities and bounds tool definitions before transport", async () => {
    for (const capabilities of [
      undefined,
      { ...model, tools: false },
      { ...model, tools: undefined },
    ]) {
      const client = createNeuralwattClient({
        apiKey: "fictional-secret",
        model: model.id,
        capabilities,
        transport: async () => {
          throw new Error("Transport must not run");
        },
      });
      await expect(client.complete({ messages, tools: [tool] })).rejects.toMatchObject({
        code: "configuration",
      });
    }
    const client = createNeuralwattClient({
      apiKey: "fictional-secret",
      model: model.id,
      capabilities: model,
      transport: async () => {
        throw new Error("Transport must not run");
      },
    });
    for (const tools of [
      [],
      [tool, tool],
      [{ ...tool, name: "../bad" }],
      [{ ...tool, parameters: { type: "object", description: "x".repeat(20000) } }],
    ])
      await expect(client.complete({ messages, tools })).rejects.toMatchObject({
        code: "configuration",
      });
  });

  test("matches assistant calls to tool IDs and strips reasoning during continuation with tools disabled", async () => {
    const client = createNeuralwattClient({
      apiKey: "fictional-secret",
      model: model.id,
      capabilities: model,
      transport: async (_url, init) => {
        const body = JSON.parse(String(init.body));
        expect(body.tools).toBeUndefined();
        expect(body.messages.at(-1)).toEqual({
          role: "tool",
          content: '{"status":"queued"}',
          tool_call_id: call.id,
        });
        expect(String(init.body)).not.toContain("private trace");
        return Response.json({
          choices: [{ message: { content: "One moment, Ember." }, finish_reason: "stop" }],
        });
      },
    });
    const assistant = {
      role: "assistant" as const,
      content: "",
      tool_calls: [wireToolCall(call)],
      reasoning: "private trace",
    };
    const result = await client.complete({
      messages: [
        ...messages,
        assistant,
        { role: "tool", content: '{"status":"queued"}', tool_call_id: call.id },
      ],
    });
    expect(result.text).toBe("One moment, Ember.");
  });

  test("rejects missing, mismatched, duplicate and orphan tool results before transport", async () => {
    const client = createNeuralwattClient({
      apiKey: "fictional-secret",
      model: model.id,
      capabilities: model,
      transport: async () => {
        throw new Error("Transport must not run");
      },
    });
    const assistant: ChatMessage = {
      role: "assistant",
      content: "",
      tool_calls: [wireToolCall(call)],
    };
    const result: ChatMessage = { role: "tool", content: "queued", tool_call_id: call.id };
    for (const suffix of [
      [assistant],
      [result],
      [assistant, { ...result, tool_call_id: "wrong" }],
      [assistant, result, result],
      [assistant, { role: "user" as const, content: "interrupt" }, result],
      [assistant, result, assistant, result],
    ])
      await expect(client.complete({ messages: [...messages, ...suffix] })).rejects.toMatchObject({
        code: "configuration",
      });
  });

  test("rejects unexpected, duplicate, oversized and partial calls without executing them", async () => {
    for (const [calls, reason] of [
      [[wireToolCall({ ...call, name: "unavailable" })], "tool_calls"],
      [[wireToolCall(call), wireToolCall(call)], "tool_calls"],
      [[wireToolCall({ ...call, arguments: "x".repeat(8193) })], "tool_calls"],
      [[wireToolCall(call)], "length"],
      [[], "tool_calls"],
      [[{ ...wireToolCall(call), type: "hosted" }], "tool_calls"],
    ] as const) {
      const client = createNeuralwattClient({
        apiKey: "fictional-secret",
        model: model.id,
        capabilities: model,
        transport: async () => toolResponse(calls, reason),
      });
      await expect(client.complete({ messages, tools: [tool] })).rejects.toMatchObject({
        code: "invalid_response",
      });
    }
  });
});
