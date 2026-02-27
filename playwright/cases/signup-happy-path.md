---
fixture: mock-signup-server
---

# Happy Path: Full Signup

## Goal

Complete a full signup flow through all four steps and verify the account is created successfully.

## Steps

1. Go to the signup page at `{{SERVER_URL}}/signup`
2. Enter "Jane" as the first name
3. Enter "Doe" as the last name
4. Click the continue button
5. Enter "janedoe" as the username
6. Enter "S3cure!Pass789" as the password
7. Click the continue button
8. The app requires a verification code. Retrieve it from `{{SERVER_URL}}/signup/verify-code` (it's in the `code` field of the JSON response)
9. Enter the verification code
10. Click the verify button
11. Check the "I am not a robot" checkbox
12. Click the complete sign up button

## Expected

- The page should say "Account created successfully"
- The page should display the username "janedoe"
