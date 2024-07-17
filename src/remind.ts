import { ProbotOctokit } from 'probot';
import { WebClient } from '@slack/web-api';
import { isQuietPeriod, timeAgo } from './util';
import { Endpoints } from '@octokit/types';
const { SLACK_BOT_TOKEN, NODE_ENV } = process.env;

if (!SLACK_BOT_TOKEN && NODE_ENV !== 'test') {
  console.error('Missing environment variable SLACK_BOT_TOKEN');
  process.exit(1);
}

type IssueOrPullRequest = Endpoints['GET /search/issues']['response']['data']['items'][number];

const slack = new WebClient(SLACK_BOT_TOKEN);

const octokit = new ProbotOctokit();

function getOwnerAndRepoFromUrl(url: string) {
  const urlObj = new URL(url);
  const pathSegments = urlObj.pathname.split('/').filter(Boolean);
  const [owner, repo] = pathSegments.slice(-2);
  return { owner, repo };
}

async function getReviewActivity(pr: IssueOrPullRequest) {
  const { owner, repo } = getOwnerAndRepoFromUrl(pr.repository_url);

  const [comments, reviewComments, reviews] = await Promise.all([
    octokit.paginate(octokit.issues.listComments, {
      owner,
      repo,
      issue_number: pr.number,
    }),
    octokit.paginate(octokit.pulls.listReviewComments, {
      owner,
      repo,
      pull_number: pr.number,
    }),
    octokit.paginate(octokit.pulls.listReviews, {
      owner,
      repo,
      pull_number: pr.number,
    }),
  ]);

  return [
    ...comments.map((item) => ({
      type: 'comment',
      user: item.user,
      author_association: item.author_association,
      created_at: new Date(item.created_at),
    })),
    ...reviewComments.map((item) => ({
      type: 'review_comment',
      user: item.user,
      author_association: item.author_association,
      created_at: new Date(item.created_at),
    })),
    ...reviews.map((item) => ({
      type: 'review',
      user: item.user,
      author_association: item.author_association,
      created_at: new Date(item.submitted_at!),
    })),
  ];
}

type PullRequestActivity = Awaited<ReturnType<typeof getReviewActivity>>[number];

async function findLatestTeamReviewActivity(pr: IssueOrPullRequest) {
  const allActivity = await getReviewActivity(pr);

  let latestActivity: PullRequestActivity | undefined;
  let latestActivityDate: Date | undefined;

  for (const activity of allActivity) {
    // Ignore older comments if one has been found
    if (latestActivityDate && latestActivityDate > activity.created_at) continue;

    // Ignore bots
    if (activity.user?.type !== 'User') continue;

    // Skip comments by PR authors
    if (activity.user?.login === pr.user?.login) continue;

    // TODO(smaddock): check for wg-api team membership instead
    // Ignore non-member comments
    // If folks' org membership is set to private, they'll appear as contributor
    if (!['MEMBER', 'OWNER', 'CONTRIBUTOR'].includes(activity.author_association)) continue;

    latestActivity = activity;
    latestActivityDate = activity.created_at;
  }

  return latestActivity;
}

async function getActivityForPRs(prs: IssueOrPullRequest[]) {
  const activity: Record<number, PullRequestActivity | void> = {};
  for (const pr of prs) {
    const latestActivity = await findLatestTeamReviewActivity(pr);
    activity[pr.number] = latestActivity;
  }
  return activity;
}

async function getElectronPRs() {
  const query = `is:pr is:open -is:draft label:"api-review/requested 🗳" -label:"api-review/approved ✅" -label:"wip ⚒"`;
  const items = await octokit.paginate(octokit.search.issuesAndPullRequests, {
    q: `repo:electron/electron ${query}`,
    sort: 'created',
  });
  const activity = await getActivityForPRs(items);
  return { items, query, activity };
}

const formatSlackDate = (d: Date) => {
  const unixSeconds = Math.floor(d.getTime() / 1000);
  return `<!date^${unixSeconds}^{date_short}|${d.toDateString()}>`;
};

async function main() {
  // silence during quiet period
  if (isQuietPeriod()) return;

  let text = '';

  const electronPRs = await getElectronPRs();

  if (electronPRs.items.length) {
    const searchUrl =
      'https://github.com/electron/electron/pulls?q=' + encodeURIComponent(electronPRs.query);

    text +=
      `:blob-wave: *Reminder:* the <${searchUrl}|following PRs> are awaiting API review.\n` +
      electronPRs.items
        .map((item) => {
          const escapedTitle = item.title.replace(
            /[&<>]/g,
            (x) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[x]!,
          );

          const activity = electronPRs.activity[item.number];
          const createdAt = new Date(item.created_at);
          const reviewLabel =
            activity
              ? `Last reviewed ${timeAgo(activity.created_at)} (${formatSlackDate(
                  activity.created_at,
                )})`
              : `Awaiting review since ${timeAgo(createdAt)} (${formatSlackDate(createdAt)})`;

          // TODO(smaddock): highlight first time contributors

          return `• *<${item.html_url}|${escapedTitle} (#${item.number})>*\n    _${reviewLabel}_`;
        })
        .join('\n');
  }

  if (text.length) {
    slack.chat.postMessage({
      channel: '#wg-api',
      unfurl_links: false,
      text,
    });
  }
}

if (require.main === module) main();
