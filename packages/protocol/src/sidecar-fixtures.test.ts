import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "bun:test";
import { z } from "zod";
import { LOCAL_SCHEMA } from "@omarchy-bot/agent-contract";
import { DeviceClientFrameSchema, DeviceServerFrameSchema } from "./devices.ts";

const directory = path.resolve(import.meta.dir, "../fixtures/sidecar");
const FixtureSchema = z.object({
  direction: z.enum(["client", "server"]),
  frame: z.record(z.unknown()),
}).strict();
const fixtures = readdirSync(directory).filter((name) => name.endsWith(".json")).sort().map((name) => ({
  name,
  ...FixtureSchema.parse(JSON.parse(readFileSync(path.join(directory, name), "utf8"))),
}));

function coverProperties(label: string, properties: Record<string, { optional: boolean }>, frames: Record<string, unknown>[]): void {
  expect(frames.length, `${label} has no fixtures`).toBeGreaterThan(0);
  for (const [property, { optional }] of Object.entries(properties)) {
    expect(frames.some((frame) => Object.hasOwn(frame, property)), `${label}.${property} is never present`).toBeTrue();
    if (optional) {
      expect(frames.some((frame) => !Object.hasOwn(frame, property)), `${label}.${property} is never absent`).toBeTrue();
    }
  }
}

test("canonical Sidecar fixtures survive the authoritative schemas without stripping or changing JSON", () => {
  expect(fixtures.length).toBeGreaterThan(0);
  for (const { name, direction, frame } of fixtures) {
    const parsed = (direction === "client" ? DeviceClientFrameSchema : DeviceServerFrameSchema).parse(frame);
    expect(JSON.parse(JSON.stringify(parsed)), name).toEqual(frame);
  }
});

test("Sidecar fixtures cover every device frame variant and its required and optional properties", () => {
  const schemas = {
    client: DeviceClientFrameSchema,
    server: DeviceServerFrameSchema.innerType(),
  };
  for (const [direction, schema] of Object.entries(schemas)) {
    for (const variant of schema.options) {
      const type = variant.shape.type.value;
      const shape: Record<string, z.ZodTypeAny> = variant.shape;
      const frames = fixtures.filter((fixture) => fixture.direction === direction && fixture.frame.type === type).map(({ frame }) => frame);
      coverProperties(`${direction}:${type}`, Object.fromEntries(
        Object.entries(shape).map(([key, property]) => [key, { optional: property.isOptional() }]),
      ), frames);
    }
  }
});

test("Sidecar job fixtures cover every LOCAL_SCHEMA action, property and transfer direction", () => {
  const jobs = fixtures.filter(({ direction, frame }) => direction === "server" && frame.type === "local.job").map(({ frame }) => frame);
  for (const { const: action } of LOCAL_SCHEMA.properties.action.anyOf) {
    expect(jobs.some((job) => job.action === action), `local.job action ${action} is missing`).toBeTrue();
  }
  const required = new Set<string>(LOCAL_SCHEMA.required);
  coverProperties("local.job", Object.fromEntries(
    Object.keys(LOCAL_SCHEMA.properties).map((property) => [property, { optional: !required.has(property) }]),
  ), jobs);
  for (const { const: direction } of LOCAL_SCHEMA.properties.direction.anyOf) {
    expect(jobs.some((job) => job.action === "transfer" && job.direction === direction), `transfer ${direction} is missing`).toBeTrue();
  }
});
