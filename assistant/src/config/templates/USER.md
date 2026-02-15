_ Lines starting with _ are comments — they won't appear in the prompt sent to your assistant.

# USER

_Your assistant learns about you over time. Fill in what you're comfortable sharing to help it help you better._

- **Name:**
- **Pronouns:**
- **What to call you:**

## Context

_(What do you care about? What are you working on? What are your preferences? Add notes here over time.)_

## Locale

_Geographic and language context. Updated during onboarding or when the user shares location details._

- **city:**
- **region:**
- **country:**
- **timezone:**
- **localeId:**
- **confidence:** low

## Dashboard Color Preference

_The user's chosen accent color for their dashboard. Updated during onboarding or when the user changes their preference._

- **label:**
- **hex:**
- **source:**
- **applied:** false

## Onboarding Tasks

_Tracks progress through onboarding steps. Each task is one of: pending, in_progress, done, deferred_to_dashboard._

- **set_name:** pending
- **set_locale:** pending
- **make_it_yours:** pending
- **research_topic:** pending
- **research_to_ui:** pending
- **first_conversation:** pending

## Trust Stage

_Tracks how far the user has progressed in building trust with the assistant. Values are true or false._

- **hatched:** false
- **firstConversationComplete:** false
- **permissionsUnlocked:** false
