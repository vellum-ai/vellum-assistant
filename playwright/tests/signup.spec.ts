import { test, expect } from "@playwright/test";

test("can sign up a new user", async ({ page }) => {
  const timestamp = Date.now();
  const username = `testuser${timestamp}`;
  const email = `testuser${timestamp}@example.com`;
  const password = "testpassword123";

  // GIVEN we are on the signup page
  await page.goto("/signup");

  // WHEN we fill out the signup form and submit
  await page.getByPlaceholder("Username").fill(username);
  await page.getByPlaceholder("Email").fill(email);
  await page.getByPlaceholder("Password (min 8 characters)").fill(password);
  await page.getByPlaceholder("Confirm password").fill(password);
  await page.getByRole("button", { name: "Create account" }).click();

  // THEN we are redirected to the assistant page
  await expect(page).toHaveURL(/\/assistant/, { timeout: 15000 });
});
