// @vitest-environment node

import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DashboardBoard } from "@paperclipai/shared";

const boardState = vi.hoisted(() => ({
  current: {} as Record<string, unknown>,
}));

vi.mock("./useDashboardBoard", () => ({
  useDashboardBoard: () => boardState.current,
}));

import { DashboardBoardShell } from "./DashboardBoardShell";

const data: DashboardBoard = {
  board: "sales",
  companyId: "11111111-1111-4111-8111-111111111111",
  generatedAt: "2026-11-23T12:00:00.000Z",
  sources: [],
  tiles: [],
  tables: [],
};

function render(children = () => <p>board body</p>) {
  return renderToStaticMarkup(
    <DashboardBoardShell board="sales" title="Sales">
      {children}
    </DashboardBoardShell>,
  );
}

beforeEach(() => {
  boardState.current = {
    companyId: "11111111-1111-4111-8111-111111111111",
    data,
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  };
});

describe("DashboardBoardShell", () => {
  it("asks for an organization before reading a board", () => {
    boardState.current = { companyId: null, data: undefined, isLoading: false, error: null };
    expect(render()).toContain("Select an organization to view the Sales board.");
  });

  it("does not render a board body while the read is pending", () => {
    boardState.current = { ...boardState.current, data: undefined, isLoading: true };
    const html = render();
    expect(html).toContain("Loading the Sales board");
    expect(html).not.toContain("board body");
  });

  it("shows a retry instead of a blank board when the read fails with nothing cached", () => {
    boardState.current = {
      ...boardState.current,
      data: undefined,
      error: new Error("network down"),
    };
    const html = render();
    expect(html).toContain("Could not load the Sales board.");
    expect(html).toContain("network down");
    expect(html).toContain("Retry");
    expect(html).not.toContain("board body");
  });

  it("keeps the last loaded board visible when a refresh fails", () => {
    boardState.current = { ...boardState.current, error: new Error("network down") };
    const html = render();
    expect(html).toContain("board body");
    expect(html).toContain("Showing the last loaded board.");
    expect(html).toContain("network down");
  });

  it("renders the board once the read succeeds", () => {
    expect(render()).toContain("board body");
  });
});
