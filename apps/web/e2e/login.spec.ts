import { expect, test } from "@playwright/test";

test("login page renders email and password fields", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByText("Email", { exact: true })).toBeVisible();
  await expect(page.getByText("Пароль", { exact: true })).toBeVisible();
});
