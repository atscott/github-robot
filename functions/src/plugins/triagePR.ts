import {Application, Context} from "probot";
import {Task} from "./task";
import {AdminConfig, TriageConfig} from "../default";
import {getLabelsNames, matchAllOfAny} from "./common";
import Github from '@octokit/rest';

export class TriagePRTask extends Task {
  constructor(robot: Application, db: FirebaseFirestore.Firestore) {
    super(robot, db);

    // PRs are issues for github
    this.dispatch([
      'pull_request.labeled',
      'pull_request.unlabeled',
      'issues.demilestoned',
      'issues.milestoned',
      'issues.opened'
    ], this.checkTriage.bind(this));
  }

  async manualInit(): Promise<void> {
    this.log('init triage PR');
    const adminConfig = await this.admin.doc('config').get();
    if(adminConfig.exists && (<AdminConfig>adminConfig.data()).allowInit) {
      const github = await this.robot.auth();
      const installations = await github.paginate(github.apps.listInstallations({}), pages => (pages as any as Github.AnyResponse).data);
      await Promise.all(installations.map(async installation => {
        const authGithub = await this.robot.auth(installation.id);
        const repositories = await authGithub.apps.listRepos({});
        await Promise.all(repositories.data.repositories.map(async (repository: Github.AppsListReposResponseRepositoriesItem) => {
          const context = new Context({payload: {repository}}, authGithub, this.robot.log);
          const config = await this.getConfig(context);
          if(config.disabled) {
            return;
          }
          const {owner, repo} = context.repo();
          const issues = await authGithub.paginate(authGithub.issues.listForRepo({
            owner,
            repo,
            state: 'open',
            per_page: 100
          }), pages => (pages as any as Github.AnyResponse).data);

          issues.forEach(async (issue: Github.IssuesListForRepoResponseItem) => {
            // We only want the PRs, not the issues
            if(issue.pull_request) {
              const isL1Triaged = this.isTriaged(config.l1TriageLabels, issue.labels.map((label: Github.IssuesListForRepoResponseItemLabelsItem) => label.name));
              if(!isL1Triaged) {
                if(issue.milestone) {
                  await this.setMilestone(null, context.github, owner, repo, issue);
                }
              } else if(!issue.milestone || issue.milestone.number === config.defaultMilestone || issue.milestone.number === config.needsTriageMilestone) {
                const isL2Triaged = this.isTriaged(config.l2TriageLabels || config.triagedLabels, issue.labels.map((label: Github.IssuesListForRepoResponseItemLabelsItem) => label.name));
                if(isL2Triaged) {
                  if(!issue.milestone || issue.milestone.number !== config.defaultMilestone) {
                    await this.setMilestone(config.defaultMilestone, context.github, owner, repo, issue);
                  }
                } else {
                  // if it's not triaged, set the "needsTriage" milestone
                  if(!issue.milestone || issue.milestone.number !== config.needsTriageMilestone) {
                    await this.setMilestone(config.needsTriageMilestone, context.github, owner, repo, issue);
                  }
                }
              }
            }
          });
        }));
      }));
    } else {
      this.logError(`Manual init is disabled: the value of allowInit is set to false in the admin config database`);
    }
  }

  async checkTriage(context: Context): Promise<void> {
    if((context.payload.issue && context.payload.issue.pull_request) || context.payload.pull_request) {
      const pr: Github.PullRequestsGetResponse | Github.IssuesGetResponse = context.payload.pull_request || context.payload.issue;
      const config = await this.getConfig(context);
      if(config.disabled) {
        return;
      }
      const {owner, repo} = context.repo();
      const isL1Triaged = this.isTriaged(config.l1TriageLabels, getLabelsNames(pr.labels));
      if(!isL1Triaged) {
        if(pr.milestone) {
          await this.setMilestone(null, context.github, owner, repo, pr);
        }
      } else if(!pr.milestone || pr.milestone.number === config.defaultMilestone || pr.milestone.number === config.needsTriageMilestone) {
        const isL2Triaged = this.isTriaged(config.l2TriageLabels || config.triagedLabels, getLabelsNames(pr.labels));
        if(isL2Triaged) {
          if(!pr.milestone || pr.milestone.number !== config.defaultMilestone) {
            await this.setMilestone(config.defaultMilestone, context.github, owner, repo, pr);
          }
        } else {
          // if it's not triaged, set the "needsTriage" milestone
          if(!pr.milestone || pr.milestone.number !== config.needsTriageMilestone) {
            await this.setMilestone(config.needsTriageMilestone, context.github, owner, repo, pr);
          }
        }
      }
    }
  }

  setMilestone(milestoneNumber: number | null, github: Github, owner: string, repo: string, PR: Github.PullRequestsGetResponse|Github.IssuesListForRepoResponseItem): Promise<Github.Response<Github.IssuesUpdateResponse>> {
    if(milestoneNumber) {
      this.log(`Adding milestone ${milestoneNumber} to PR ${PR.html_url}`);
    } else {
      this.log(`Removing milestone from PR ${PR.html_url}`);
    }
    return github.issues.update({owner, repo, number: PR.number, milestone: milestoneNumber}).catch(err => {
      throw err;
    });
  }

  isTriaged(triagedLabels: string[][], currentLabels: string[]): boolean {
    return matchAllOfAny(currentLabels, triagedLabels);
  }

  /**
   * Gets the config for the merge plugin from Github or uses default if necessary
   */
  async getConfig(context: Context): Promise<TriageConfig> {
    const repositoryConfig = await this.getAppConfig(context);
    const config = repositoryConfig.triagePR;
    config.defaultMilestone = parseInt(<unknown>config.defaultMilestone as string, 10);
    config.needsTriageMilestone = parseInt(<unknown>config.needsTriageMilestone as string, 10);
    return config;
  }
}
