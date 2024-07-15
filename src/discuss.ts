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

async function main() {
  const q = `is:pr is:open -is:draft -label:"pending-changes"`;
  const items = await octokit.paginate(octokit.search.issuesAndPullRequests, {
    q: `repo:electron/rfcs ${q}`,
    sort: 'created',
    order: 'asc',
  });

  // const apiWg = await getApiWGMembers();
  // console.log(apiWg);
  
  if (items.length) {
    // console.log('rfcs', items);
    for (const item of items) {
      const { data: comments } = await octokit.issues.listComments({
        owner: 'electron',
        repo: 'rfcs',
        issue_number: item.number
      });
      console.log(`comments for ${item.title}`, comments);
      
      const { data: reviewComments } = await octokit.pulls.listReviewComments({
        owner: 'electron',
        repo: 'rfcs',
        pull_number: item.number
      });
      console.log(`review comments for ${item.title}`, reviewComments);
    }
  }
}

if (require.main === module) main();
