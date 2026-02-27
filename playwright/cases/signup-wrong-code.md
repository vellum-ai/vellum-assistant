---
fixture: mock-signup-server
---

# Wrong Verification Code Shows Error

## Goal

Submit an incorrect verification code during signup and verify the error message is displayed.

## Steps

1. Navigate to `{{SERVER_URL}}/signup`
2. Fill in "Test" for the first name field (`input[name="first_name"]`)
3. Fill in "User" for the last name field (`input[name="last_name"]`)
4. Click the submit button (`button[type="submit"]`)
5. Fill in "testuser" for the username field (`input[name="username"]`)
6. Fill in "S3cure!Pass789" for the password field (`input[name="password"]`)
7. Click the submit button (`button[type="submit"]`)
8. Fill in "000000" for the verification code field (`input[name="code"]`)
9. Click the submit button (`button[type="submit"]`)

## Expected

- The page body should contain the text "Invalid verification code"
