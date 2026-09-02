import { render, screen } from "@testing-library/react";
import HomePage from "./page";

it("introduces Inventory Autopilot", () => {
  render(<HomePage />);

  expect(
    screen.getByRole("heading", { level: 1, name: "Автопілот запасів" }),
  ).toBeVisible();
});
