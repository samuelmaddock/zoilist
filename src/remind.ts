import { ProbotOctokit } from 'probot';
import { WebClient } from '@slack/web-api';
import { isQuietPeriod, timeAgo } from './util';
import { Endpoints } from '@octokit/types';
const { SLACK_BOT_TOKEN, NODE_ENV } = process.env;

if (!SLACK_BOT_TOKEN && NODE_ENV !== 'test' && 0) {
  console.error('Missing environment variable SLACK_BOT_TOKEN');
  process.exit(1);
}

type IssueOrPullRequest = Endpoints['GET /search/issues']['response']['data']['items'][number];
// type Comment = RestEndpointMethodTypes['issues']['listComments']['response']['data'][0];
// type ReviewComment = RestEndpointMethodTypes['pulls']['listReviewComments']['response']['data'][0];
// type CommentOrReviewComment = Comment | ReviewComment;

const slack = new WebClient(SLACK_BOT_TOKEN);

const octokit = new ProbotOctokit();

const getCommentInfo = (comment: any) => ({
  'user.login': comment.user.login,
  'user.type': comment.user.type,
  author_association: comment.author_association,
  pull_request_review_id: comment.pull_request_review_id,
  issue_url: comment.issue_url,
  created_at: comment.created_at,
});

function getOwnerAndRepoFromUrl(url: string) {
  const urlObj = new URL(url);
  const pathSegments = urlObj.pathname.split('/').filter(Boolean);
  const [owner, repo] = pathSegments.slice(-2);
  return { owner, repo };
}

async function getReviewComments(pr: IssueOrPullRequest) {
  if (pr.comments === 0) return [];

  const { owner, repo } = getOwnerAndRepoFromUrl(pr.repository_url);

  const [comments, reviewComments] = await Promise.all([
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
  ]);

  return [...comments, ...reviewComments];
}

async function findLatestTeamReviewComment(pr: IssueOrPullRequest) {
  const comments = await getReviewComments(pr);

  let latestComment: (typeof comments)[0] | undefined;
  let latestCommentDate: Date | undefined;

  for (const comment of comments) {
    const createdAtDate = new Date(comment.created_at);

    // Ignore older comments if one has been found
    if (latestCommentDate && latestCommentDate > createdAtDate) continue;

    // Ignore bots
    if (comment.user?.type !== 'User') continue;

    // Skip comments by PR authors
    if (comment.user.login === pr.user?.login) continue;

    // Ignore non-member comments
    // TODO(smaddock): check for wg-api team membership
    if (!['MEMBER', 'OWNER'].includes(comment.author_association)) continue;

    latestComment = comment;
    latestCommentDate = createdAtDate;
  }

  console.log(
    `latest comment for ${pr.title}`,
    latestComment ? getCommentInfo(latestComment) : null,
  );

  return latestComment;
}

async function getElectronPRs() {
  const query = `is:pr is:open -is:draft label:"api-review/requested 🗳" -label:"api-review/approved ✅" -label:"wip ⚒"`;
  const items = await octokit.paginate(octokit.search.issuesAndPullRequests, {
    q: `repo:electron/electron ${query}`,
    sort: 'created',
  });

  const activity: Record<number, Date> = {};
  for (const item of items) {
    const latestComment = await findLatestTeamReviewComment(item);
    if (latestComment) {
      activity[item.number] = new Date(latestComment.created_at);
    }
  }

  return { items, query, activity };
}

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
          const formatDate = (d: Date) => {
            const unixSeconds = Math.floor(d.getTime() / 1000);
            return `<!date^${unixSeconds}^{date_short}|${d.toDateString()}>`;
          };

          const reviewLabel = activity
            ? `Last reviewed ${timeAgo(activity)} (${formatDate(activity)})`
            : `No review since ${timeAgo(createdAt)} (${formatDate(createdAt)})`;

          // TODO(smaddock): highlight first time contributors

          return `• *<${item.html_url}|${escapedTitle} (#${item.number})>*\n_${reviewLabel}_`;
        })
        .join('\n');
  }

  if (text.length === 0) return;

  if (1) {
    console.log(text);
    return;
  }

  slack.chat.postMessage({
    channel: '#wg-api',
    unfurl_links: false,
    text,
  });
}

if (require.main === module) main();
