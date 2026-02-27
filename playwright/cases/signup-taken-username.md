---
fixture: mock-signup-server
---

# Taken Username Shows Validation Error

## Goal

Attempt to sign up with a username that is already taken and verify the appropriate error is shown.

## Steps

1. Navigate to `{{SERVER_URL}}/signup`
2. Fill in "Test" for the first name field (`input[name="first_name"]`)
3. Fill in "User" for the last name field (`input[name="last_name"]`)
4. Click the submit button (`button[type="submit"]`)
5. Fill in "taken" for the username field (`input[name="username"]`)
6. Fill in "S3cure!Pass789" for the password field (`input[name="password"]`)
7. Click the submit button (`button[type="submit"]`)

## Expected

- The page body should contain the text "taken"
