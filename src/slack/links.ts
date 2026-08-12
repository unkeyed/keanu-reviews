/**
 * A web-openable deep link to a Slack channel. `app_redirect` resolves to the
 * channel in the browser or desktop app without needing the workspace domain.
 */
export function slackChannelUrl(teamId: string, channelId: string): string {
  return `https://slack.com/app_redirect?channel=${channelId}&team=${teamId}`;
}
