---
fixture: desktop-app-hatched
status: experimental
---

# Phone & Voice Setup

## Goal
Verify that we're able to configure everything needed for the assistant to be able to make phone calls to its guardian.


## Steps

1. Launch the App
2. Open a chat thread
3. Send the message "Can you make phone calls for me?"
4. Verify that the assistant responds in the affirmative that it is able to make phone calls, but that some initial setup is needed. If prompted, state that you already have a Twilio account.
5. You will be asked to provide your Twilio Account SID, your Twilio Auth Token, and your ngrok Auth Token, all through new windows that pop open titled "Secure Credential." Use fill_secure_credential for each one with these env var names:
   - `TWILIO_ACCOUNT_SID` for the Twilio Account SID
   - `TWILIO_AUTH_TOKEN` for the Twilio Auth Token
   - `NGROK_AUTH_TOKEN` for the ngrok Auth Token
6. Verify that you were able to supply all three credentials through a secure window and were NOT encouraged to provide them conversationally through the chat interface.
7. You should be asked what voice you want the assistant to have and be presented with a few options to choose from. Pick any voice.
8. You should be offered to make a test call to your phone number. You can reject this offer.
9. Once it seems like phone calling is fully set up, go to Preferences -> Settings -> Channels. There you should see that phone calling is fully configured.

**IMPORTANT**: ALL steps above must be completed and verified for the test to pass. Do not report pass if you haven't gotten through every step.


## Expected
- The assistant initially responds in the affirmative that it is able to make phone calls
- The assistant should offer a secure pop-up prompting you to enter your Twilio Account SID, Twilio Auth Token, and ngrok Auth Token and should NOT necourage you to provide them conversationally
- At some point you should be presented with a selection of voice options to choose from for the assistant.
- Once set up is complete, you should be offered to make a test call to your phone number.
- Phone calling should display as being fully configured under Preferences -> Settings -> Channels