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
5. You should first be asked for your Twilio Account SID. Provide this conversationally through the chat by including `${TWILIO_ACCOUNT_SID}` in your message (it will be resolved automatically).
6. You should then be asked for your Twilio Auth Token. Verify that you are asked to supply it securely through a separate window. Use the `fill_secure_credential` tool to enter it.
7. From there, continue the conversation naturally. At some point, you should be asked for your ngrok Auth Token. Verify that you are asked to supply it securely through a separate window. Use the `fill_secure_credential` tool to enter it.
8. Continue the conversation naturally. At some point you should be asked what voice you want the assistant to have and be presented with a few options to choose from. Pick any voice.
9. You should be offered to make a test call to your phone number. You can reject this offer.
10. Once it seems like phone calling is fully set up, go to Preferences -> Settings -> Channels. There you should see that phone calling is fully configured.


## Expected
- You were able to complete all steps
- The assistant initially responds in the affirmative that it is able to make phone calls
- The assistant should ask for yout Twilio Account SID conversationally
- The assistant should ask for your Twilio Auth Token and ngrok Auth Token through a separate secure pop-up
- At some point you should be presented with a selection of voice options to choose from for the assistant.
- Once set up is complete, you should be offered to make a test call to your phone number.
- Phone calling should display as being fully configured under Preferences -> Settings -> Channels
