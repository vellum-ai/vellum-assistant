---
fixture: desktop-app
experimental: true
---

# Phone & Voice Setup

## Goal
Verify that we're able to configure everything needed for the assistant to be able to make phone calls to its guardian.


## Steps

1. Launch the App
2. Open a chat thread
3. Send the message "Can you make phone calls for me?"
4. Verify that you're asked to enter your Twilio Account SID, your Twilio Auth Token, and your ngrok Auth Token. You should be asked to enter them securely through a pop-up, not conversationally through the chat.
5. You should be asked what voice you want the assistant to have and be presented with a few options to choose from.
6. You should be offered to make a test call to your phone number. You can reject this offer.
7. Once it seems like phone calling is fully set up, go to Preferences -> Settings -> Channels. There you should see that phone calling is fully configured.


## Expected
- The assistant should offer a secure pop-up prompting you to enter your Twilio Account SID, Twilio Auth Token, and ngrok Auth Token and should NOT necourage you to provide them conversationally
- At some point you should be presented with a selection of voice options to choose from for the assistant.
- Once set up is complete, you should be offered to make a test call to your phone number.
- Phone calling should display as being fully configured under Preferences -> Settings -> Channels