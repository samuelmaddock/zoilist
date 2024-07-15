import { ProbotOctokit } from 'probot';
// import { WebClient } from '@slack/web-api';
// const { SLACK_BOT_TOKEN, NODE_ENV } = process.env;

// if (!SLACK_BOT_TOKEN && NODE_ENV !== 'test') {
//   console.error('Missing environment variable SLACK_BOT_TOKEN');
//   process.exit(1);
// }

// const slack = new WebClient(SLACK_BOT_TOKEN);

const octokit = new ProbotOctokit();

// async function getApiWGMembers() {
//   try {
//     // Fetch team members
//     const { data: teamMembers } = await octokit.teams.listMembersInOrg({
//       org: 'electron',
//       team_slug: 'wg-api'
//     });

//     // Extract usernames of team members
//     const userGroup = teamMembers.map(member => member?.login).filter(Boolean);
//     return userGroup as string[];
//   } catch (error: any) {
//     console.error(`Error fetching team members: ${error?.message}`);
//     return [];
//   }
// }

async function findStaleRFCs() {
  const twoWeeksAgoDate = new Date();
  twoWeeksAgoDate.setDate(twoWeeksAgoDate.getDate() - 14);

  const q = `is:pr is:open -is:draft -label:"pending-changes"`;
  const prs = await octokit.paginate(octokit.search.issuesAndPullRequests, {
    q: `repo:electron/rfcs ${q}`,
    sort: 'created',
    order: 'asc',
  });

  const getDetails = (comment: any) => ({
    'user.login': comment.user.login,
    'user.type': comment.user.type,
    author_association: comment.author_association,
    pull_request_review_id: comment.pull_request_review_id,
    issue_url: comment.issue_url,
    created_at: comment.created_at,
  });

  const stalePrs: (typeof prs)[0][] = [];

  if (prs.length) {
    for (const pr of prs) {
      const [comments, reviewComments] = await Promise.all([
        octokit.paginate(octokit.issues.listComments, {
          owner: 'electron',
          repo: 'rfcs',
          issue_number: pr.number,
        }),
        octokit.paginate(octokit.pulls.listReviewComments, {
          owner: 'electron',
          repo: 'rfcs',
          pull_number: pr.number,
        }),
      ]);

      const allComments = [...comments, ...reviewComments];

      let latestComment: (typeof allComments)[0] | undefined;
      let latestCommentDate: Date | undefined;

      for (const comment of allComments) {
        const createdAtDate = new Date(comment.created_at);

        // Ignore older comments if one has been found
        if (latestCommentDate && latestCommentDate > createdAtDate) continue;

        // Ignore bots
        if (comment.user?.type !== 'User') continue;

        // Ignore non-member comments
        // TODO(smaddock): check for wg-api team membership
        if (!['MEMBER', 'OWNER'].includes(comment.author_association)) continue;

        latestComment = comment;
        latestCommentDate = createdAtDate;
      }

      console.log(
        `latest comment for ${pr.title}`,
        latestComment ? getDetails(latestComment) : null,
      );
      const isStale = !latestCommentDate || latestCommentDate < twoWeeksAgoDate;

      if (isStale) {
        stalePrs.push(pr);
      }
    }
  }

  return stalePrs;
}

async function main() {
  const staleRFCs = await findStaleRFCs();

  console.log(
    'stale RFCs',
    staleRFCs.map((pr) => pr.title),
  );
}

if (require.main === module) main();
