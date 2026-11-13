# Relay — Hackathon Submission

**Tagline:** A transparent AI assistant for the calls you do not have time to make.

## Project description

Relay is a mobile-friendly AI phone assistant that can place a call for a specific task and answer an assigned phone number. It speaks naturally, follows the purpose provided by its owner, and clearly says it is an AI assistant. Relay can take a short message or help arrange a callback, but it will not pretend to be its owner or make commitments. The owner can see call status and end a call from a protected dashboard. The default stack uses Vapi, Google Gemini, Deepgram, and Vapi Voices, so it runs without OpenAI credentials or OpenAI API calls.

## Theme fit

Relay applies AI and natural-language conversation to everyday tasks: a person explains what needs to be handled, then a voice assistant conducts a focused phone conversation while keeping the person in control of decisions.

## Demo and source

- **Hosted app:** [https://relay-call-assistant.onrender.com](https://relay-call-assistant.onrender.com)
- **Public source:** [https://github.com/Expertcomplement/relay-call-assistant](https://github.com/Expertcomplement/relay-call-assistant)

The hosted dashboard is password protected because it can place real calls. Share demo sign-in details with organizers through a private channel. Actual calling requires a connected Vapi account and phone number; the public repository intentionally contains no provider secrets.

## Suggested demo walkthrough

1. Sign in to the Relay dashboard on a phone.
2. Enter a number in international format and a short, clear call purpose.
3. Confirm authorization and place the call.
4. Show the call status, the assistant's AI disclosure, and the owner-controlled end-call button.
5. If inbound calling is configured, call the connected number and show Relay answering as an AI assistant.

## Stack

- Node.js and Express for the protected web app and server-side call controls.
- Vapi for phone calling, with Google Gemini as the default configurable language model.
- Optional OpenAI Live adapter for deployments that choose it; the default Vapi route is OpenAI independent.
- Render for the hosted web service.

## Safety and privacy

Relay identifies itself as AI, limits the conversation to the stated purpose, and does not make commitments or spend money. Outbound calls require an authorization confirmation. Relay does not persist recordings or transcripts in its own database; provider-side retention and billing are controlled by the connected accounts. Use requires appropriate consent, AI disclosure, caller identification, and compliance with local calling rules.

## Current scope

Relay currently handles a single call at a time and keeps recent call state in memory, so it resets on app restart. Provider credentials, imported phone numbers, and real-call charges are supplied by the operator and are not included in the published source.
