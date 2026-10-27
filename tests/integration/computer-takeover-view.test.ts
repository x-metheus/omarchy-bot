import { expect, test } from "bun:test";
import { isSurfaceId } from "../../packages/domain/src/ids.ts";
import { ComputerViewDto } from "../../packages/protocol/src/api.ts";
import { computerView } from "../../apps/daemon/src/api/computerRoutes.ts";
import type { ComputerBrokerState } from "../../apps/daemon/src/modules/computer/broker.ts";

const reason = 'Complete login <img src=x onerror="alert(1)">';
const surfaceId = "surf_0123456789abcdef0123456789abcdef";
if (!isSurfaceId(surfaceId)) throw new Error("Invalid test Surface identity");
const state = {
  botId: "bot-takeover",
  surfaceId,
  screenUse: "human",
  takeover: "available",
  takeoverReason: reason,
  webControlActive: false,
} satisfies ComputerBrokerState;

test("Computer view preserves the takeover reason while waiting for human control", () => {
  const view = ComputerViewDto.parse(computerView(state, { state: "ready" }));
  expect(view.state).toBe("needs-you");
  expect(view.takeoverReason).toBe(reason);
});

test("Computer view shows user control when Web Control is active during a requested takeover", () => {
  const view = ComputerViewDto.parse(computerView({ ...state, takeover: "active", webControlActive: true }, { state: "ready" }));
  expect(view.state).toBe("user-control");
  expect(view.takeoverReason).toBe(reason);
});
