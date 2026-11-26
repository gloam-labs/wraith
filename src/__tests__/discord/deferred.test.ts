/**
 * A member must never be left on "VEIL is thinking…" with no end.
 *
 * Discord shows that line until the bot replaces it. On the bot's first day
 * members were stuck on it because a chain read behind the reply hung.
 */
const editInteractionReply = jest.fn();
jest.mock("../../discord/discordApi", () => ({
  ...jest.requireActual("../../discord/discordApi"),
  editInteractionReply: (...args: unknown[]) => editInteractionReply(...args),
}));
jest.mock("../../db", () => ({ prisma: {} }));
jest.mock("../../discord/sync", () => ({ syncMember: jest.fn(), clearRoles: jest.fn() }));

import type { Response } from "express";

import { _deferred } from "../../discord/interactions";

const config = { applicationId: "1", publicKey: "k", botToken: "t", guildId: "2" };

function fakeResponse() {
  return { json: jest.fn() } as unknown as Response & { json: jest.Mock };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
  jest.clearAllMocks();
  editInteractionReply.mockResolvedValue(undefined);
});

it("answers Discord at once and then writes the result", async () => {
  const res = fakeResponse();
  _deferred(config, res, "token", async () => "Your roles: **Veil Wallet**.");
  expect(res.json).toHaveBeenCalledWith({ type: 5, data: { flags: 64 } });
  await settle();
  expect(editInteractionReply).toHaveBeenCalledTimes(1);
  expect(editInteractionReply).toHaveBeenCalledWith(config, "token", { content: "Your roles: **Veil Wallet**." });
});

it("tells the member it is still working when the work has not come back in time", async () => {
  const res = fakeResponse();
  _deferred(config, res, "token", () => new Promise<string>(() => undefined), 20);
  await new Promise((resolve) => setTimeout(resolve, 60));
  expect(editInteractionReply).toHaveBeenCalledTimes(1);
  expect(editInteractionReply.mock.calls[0][2].content).toContain("taking longer than usual");
});

it("replaces the holding message with the real answer when it does arrive", async () => {
  const res = fakeResponse();
  _deferred(config, res, "token", () => new Promise<string>((resolve) => setTimeout(() => resolve("Done."), 60)), 20);
  await new Promise((resolve) => setTimeout(resolve, 120));
  expect(editInteractionReply.mock.calls.map((call) => call[2].content)).toEqual([
    expect.stringContaining("taking longer than usual"),
    "Done.",
  ]);
});

it("writes an apology, not silence, when the work fails", async () => {
  const res = fakeResponse();
  _deferred(config, res, "token", async () => {
    throw new Error("boom");
  });
  await settle();
  expect(editInteractionReply.mock.calls[0][2].content).toContain("Something went wrong on our side");
});

it("does not throw when Discord refuses the edit", async () => {
  editInteractionReply.mockRejectedValue(new Error("Discord 404"));
  const res = fakeResponse();
  _deferred(config, res, "token", async () => "ok");
  await settle();
  expect(editInteractionReply).toHaveBeenCalledTimes(1);
});
