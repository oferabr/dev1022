### BitBucket Webhook server 

#### Info
Lambda that simulates webhook server.
The lambda listen to POST events on the route: *API_GATEWAY/api/v1/bitbucket/webhook*

List of available event types: [here](https://developer.atlassian.com/bitbucket/api/2/reference/resource/repositories/%7Bworkspace%7D/%7Brepo_slug%7D/hooks).

#### Event headers
every event has 3 main headers:
- **x-event-key** - the type of the event, e.g: 'pullrequest:created', 'pullrequest:updated' ...
- **x-hook-uuid** - the event id

The endpoint is public (it gets events directly from BitBuket server)

#### Security
todo: In order to verify that the events are real we need that the webhook will be encrypted. 