import { render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import DashboardPage from "./page";

const getServerEnv = vi.hoisted(() => vi.fn());
vi.mock("@/lib/env", () => ({ getServerEnv }));

beforeEach(() => {
  getServerEnv.mockClear();
  getServerEnv.mockReturnValue({ DATA_MODE: "live" });
});

it("D14-02 renders the syncing shell with no draft affordances", () => {
  render(<DashboardPage />);

  expect(screen.getByRole("heading", { level: 1, name: "Синхронізуємо історію покупок" })).toBeVisible();
  expect(screen.queryByRole("button")).toBeNull();
  expect(screen.queryByRole("link", { name: /Оформити/ })).toBeNull();
  expect(screen.queryByText(/^Разом/)).toBeNull();
  expect(screen.queryByText("Демонстраційні дані")).toBeNull();
});

it("D14-02 reads the mode on the request path", () => {
  getServerEnv.mockReturnValue({ DATA_MODE: "demo" });

  render(<DashboardPage />);

  expect(getServerEnv).toHaveBeenCalledOnce();
  expect(screen.getByText("Демонстраційні дані")).toBeVisible();
});
