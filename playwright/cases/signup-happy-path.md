---
fixture: mock-signup-server
---

# Happy Path: Full Signup

## Goal

Complete a full signup flow through all four steps and verify the account is created successfully.

## Steps

1. Navigate to `{{SERVER_URL}}/signup`
2. Verify the page loaded successfully (status 200)
3. Fill in "Jane" for the first name field (`input[name="first_name"]`)
4. Fill in "Doe" for the last name field (`input[name="last_name"]`)
5. Click the submit button (`button[type="submit"]`)
6. Fill in "janedoe" for the username field (`input[name="username"]`)
7. Fill in "S3cure!Pass789" for the password field (`input[name="password"]`)
8. Click the submit button (`button[type="submit"]`)
9. Fetch the verification code by making a GET request to `{{SERVER_URL}}/signup/verify-code` and extracting the `code` field from the JSON response
10. Fill the verification code into the code field (`input[name="code"]`)
11. Click the submit button (`button[type="submit"]`)
12. Check the CAPTCHA checkbox (`input[name="captcha_solved"]`)
13. Click the submit button (`button[type="submit"]`)

## Expected

- The page body should contain the text "Account created successfully"
- The page body should contain the text "janedoe"
