import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';

import * as create from './create-svg';
import * as template from './color-template';
import * as type from './type';

const token = process.env.GITHUB_TOKEN;
const org = process.env.ORG;
const outputDir =
    process.env.OUTPUT_DIR || 'profile-3d-contrib';

if (!token) {
    throw new Error('GITHUB_TOKEN is required');
}

if (!org) {
    throw new Error('ORG is required');
}

const api = axios.create({
    baseURL: 'https://api.github.com',
    headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
    },
});

interface RepoInfo {
    name: string;
    isFork: boolean;
    isArchived: boolean;
    createdAt: string;
    stargazerCount: number;
    forkCount: number;

    defaultBranchRef: {
        name: string;
    } | null;

    primaryLanguage: {
        name: string;
        color: string | null;
    } | null;
}

interface RepoConnection {
    nodes: RepoInfo[];

    pageInfo: {
        hasNextPage: boolean;
        endCursor: string | null;
    };
}

async function graphql<T>(
    query: string,
    variables: Record<string, unknown>,
): Promise<T> {
    const response = await api.post('/graphql', {
        query,
        variables,
    });

    if (response.data.errors) {
        throw new Error(
            JSON.stringify(
                response.data.errors,
                null,
                2,
            ),
        );
    }

    return response.data.data as T;
}

async function loadRepositories(): Promise<RepoInfo[]> {
    const repos: RepoInfo[] = [];

    let cursor: string | null = null;

    do {
        const result: {
            organization: {
                repositories: RepoConnection;
            } | null;
        } = await graphql(
            `
            query($org: String!, $cursor: String) {
              organization(login: $org) {
                repositories(
                  first: 100
                  after: $cursor
                  orderBy: {
                    field: NAME
                    direction: ASC
                  }
                ) {
                  nodes {
                    name
                    isFork
                    isArchived
                    createdAt
                    stargazerCount
                    forkCount

                    defaultBranchRef {
                      name
                    }

                    primaryLanguage {
                      name
                      color
                    }
                  }

                  pageInfo {
                    hasNextPage
                    endCursor
                  }
                }
              }
            }
            `,
            {
                org,
                cursor,
            },
        );

        if (!result.organization) {
            throw new Error(
                `Organization ${org} not found or token cannot access it`,
            );
        }

        const connection =
            result.organization.repositories;

        repos.push(...connection.nodes);

        cursor = connection.pageInfo.endCursor;

        if (!connection.pageInfo.hasNextPage) {
            break;
        }
    } while (true);

    return repos.filter(
        (repo) =>
            !repo.isFork &&
            !repo.isArchived &&
            repo.defaultBranchRef !== null &&
            // 避免 GitHub Action 每天提交 SVG 后把自己算进去
            repo.name !== '.github',
    );
}

function dateOnly(value: Date): string {
    return value.toISOString().slice(0, 10);
}

function getCalendarRange(): {
    start: Date;
    end: Date;
} {
    const now = new Date();

    const end = new Date(
        Date.UTC(
            now.getUTCFullYear(),
            now.getUTCMonth(),
            now.getUTCDate(),
        ),
    );

    // GitHub contribution graph 从星期日开始
    const start = new Date(end);

    start.setUTCDate(
        start.getUTCDate() -
            start.getUTCDay() -
            52 * 7,
    );

    return {
        start,
        end,
    };
}

async function collectRepoCommits(
    repo: RepoInfo,
    start: Date,
    end: Date,
    days: Map<string, number>,
): Promise<number> {
    if (!repo.defaultBranchRef) {
        return 0;
    }

    const untilDate = new Date(end);

    untilDate.setUTCDate(
        untilDate.getUTCDate() + 1,
    );

    untilDate.setUTCMilliseconds(-1);

    let page = 1;
    let total = 0;

    while (true) {
        try {
            const response = await api.get(
                `/repos/${org}/${repo.name}/commits`,
                {
                    params: {
                        sha: repo.defaultBranchRef.name,
                        since: start.toISOString(),
                        until: untilDate.toISOString(),
                        per_page: 100,
                        page,
                    },
                },
            );

            const commits = response.data as Array<any>;

            for (const item of commits) {
                const date =
                    item.commit?.author?.date ||
                    item.commit?.committer?.date;

                if (!date) {
                    continue;
                }

                const key = date.slice(0, 10);

                days.set(
                    key,
                    (days.get(key) || 0) + 1,
                );

                total++;
            }

            if (commits.length < 100) {
                break;
            }

            page++;
        } catch (error: any) {
            // 空仓库
            if (
                error.response?.status === 409
            ) {
                return total;
            }

            throw error;
        }
    }

    return total;
}

function quantile(
    values: number[],
    ratio: number,
): number {
    if (values.length === 0) {
        return 0;
    }

    const index = Math.max(
        0,
        Math.ceil(values.length * ratio) - 1,
    );

    return values[
        Math.min(index, values.length - 1)
    ];
}

function contributionLevel(
    count: number,
    q1: number,
    q2: number,
    q3: number,
): number {
    if (count === 0) {
        return 0;
    }

    if (count <= q1) {
        return 1;
    }

    if (count <= q2) {
        return 2;
    }

    if (count <= q3) {
        return 3;
    }

    return 4;
}

async function searchCount(
    query: string,
): Promise<number> {
    try {
        const response = await api.get(
            '/search/issues',
            {
                params: {
                    q: query,
                    per_page: 1,
                },
            },
        );

        return response.data.total_count || 0;
    } catch (error) {
        console.warn(
            `Cannot query "${query}". ` +
                `Check Issues / Pull requests token permissions.`,
        );

        return 0;
    }
}

async function countReviews(
    start: Date,
    end: Date,
): Promise<number> {
    try {
        let page = 1;
        let totalReviews = 0;

        const startDate = dateOnly(start);

        while (page <= 10) {
            const response = await api.get(
                '/search/issues',
                {
                    params: {
                        q:
                            `org:${org} ` +
                            `is:pr ` +
                            `updated:>=${startDate}`,
                        per_page: 100,
                        page,
                    },
                },
            );

            const items =
                response.data.items as Array<any>;

            for (const item of items) {
                const repositoryUrl =
                    item.repository_url as string;

                const repoName =
                    repositoryUrl
                        .split('/')
                        .pop() || '';

                let reviewPage = 1;

                while (true) {
                    const reviewsResponse =
                        await api.get(
                            `/repos/${org}/${repoName}` +
                                `/pulls/${item.number}/reviews`,
                            {
                                params: {
                                    per_page: 100,
                                    page: reviewPage,
                                },
                            },
                        );

                    const reviews =
                        reviewsResponse.data as Array<any>;

                    for (const review of reviews) {
                        if (!review.submitted_at) {
                            continue;
                        }

                        const submitted =
                            new Date(
                                review.submitted_at,
                            );

                        if (
                            submitted >= start &&
                            submitted <= end
                        ) {
                            totalReviews++;
                        }
                    }

                    if (reviews.length < 100) {
                        break;
                    }

                    reviewPage++;
                }
            }

            if (items.length < 100) {
                break;
            }

            page++;
        }

        return totalReviews;
    } catch (error) {
        console.warn(
            'Cannot collect PR reviews. ' +
                'Check Pull requests: Read-only permission.',
        );

        return 0;
    }
}

async function main(): Promise<void> {
    const {
        start,
        end,
    } = getCalendarRange();

    console.log(
        `Organization: ${org}`,
    );

    console.log(
        `Period: ${dateOnly(start)} / ${dateOnly(end)}`,
    );

    const repos =
        await loadRepositories();

    console.log(
        `Repositories: ${repos.length}`,
    );

    const days =
        new Map<string, number>();

    const languageMap =
        new Map<
            string,
            {
                language: string;
                color: string;
                contributions: number;
            }
        >();

    let totalCommits = 0;

    for (const repo of repos) {
        try {
            const commitCount =
                await collectRepoCommits(
                    repo,
                    start,
                    end,
                    days,
                );

            totalCommits +=
                commitCount;

            console.log(
                `${repo.name}: ${commitCount} commits`,
            );

            if (
                repo.primaryLanguage &&
                commitCount > 0
            ) {
                const language =
                    repo.primaryLanguage.name;

                const current =
                    languageMap.get(language);

                if (current) {
                    current.contributions +=
                        commitCount;
                } else {
                    languageMap.set(
                        language,
                        {
                            language,
                            color:
                                repo.primaryLanguage
                                    .color ||
                                '#444444',
                            contributions:
                                commitCount,
                        },
                    );
                }
            }
        } catch (error) {
            console.warn(
                `Failed to scan ${repo.name}`,
            );

            console.warn(error);
        }
    }

    const positiveCounts =
        Array.from(days.values())
            .filter((value) => value > 0)
            .sort((a, b) => a - b);

    const q1 = quantile(
        positiveCounts,
        0.25,
    );

    const q2 = quantile(
        positiveCounts,
        0.50,
    );

    const q3 = quantile(
        positiveCounts,
        0.75,
    );

    const contributionCalendar:
        type.CalendarInfo[] = [];

    const cursor =
        new Date(start);

    while (cursor <= end) {
        const key =
            dateOnly(cursor);

        const count =
            days.get(key) || 0;

        contributionCalendar.push({
            contributionCount:
                count,

            contributionLevel:
                contributionLevel(
                    count,
                    q1,
                    q2,
                    q3,
                ),

            date:
                new Date(cursor),
        });

        cursor.setUTCDate(
            cursor.getUTCDate() + 1,
        );
    }

    const startDate =
        dateOnly(start);

    const issueCount =
        await searchCount(
            `org:${org} ` +
                `is:issue ` +
                `created:>=${startDate}`,
        );

    const pullRequestCount =
        await searchCount(
            `org:${org} ` +
                `is:pr ` +
                `created:>=${startDate}`,
        );

    const reviewCount =
        await countReviews(
            start,
            end,
        );

    const repositoryCount =
        repos.filter(
            (repo) =>
                new Date(
                    repo.createdAt,
                ) >= start,
        ).length;

    const totalStars =
        repos.reduce(
            (sum, repo) =>
                sum +
                repo.stargazerCount,
            0,
        );

    const totalForks =
        repos.reduce(
            (sum, repo) =>
                sum +
                repo.forkCount,
            0,
        );

    const languages =
        Array.from(
            languageMap.values(),
        ).sort(
            (a, b) =>
                b.contributions -
                a.contributions,
        );

    const info:
        type.UserInfo = {
        isHalloween:
            end.getUTCMonth() === 9 &&
            end.getUTCDate() === 31,

        contributionCalendar,

        contributesLanguage:
            languages,

        // Organization 没有官方 contributionsCollection，
        // 因此 3D Calendar 这里定义为 default branch commits
        totalContributions:
            totalCommits,

        totalCommitContributions:
            totalCommits,

        totalIssueContributions:
            issueCount,

        totalPullRequestContributions:
            pullRequestCount,

        totalPullRequestReviewContributions:
            reviewCount,

        totalRepositoryContributions:
            repositoryCount,

        totalForkCount:
            totalForks,

        totalStargazerCount:
            totalStars,
    };

    console.log({
        totalCommits,
        issueCount,
        pullRequestCount,
        reviewCount,
        repositoryCount,
        totalStars,
        totalForks,
    });

    fs.mkdirSync(
        outputDir,
        {
            recursive: true,
        },
    );

    function write(
        filename: string,
        svg: string,
    ): void {
        fs.writeFileSync(
            path.join(
                outputDir,
                filename,
            ),
            svg,
            'utf8',
        );
    }

    const normalSettings =
        info.isHalloween
            ? template.HalloweenSettings
            : template.NormalSettings;

    // 以下部分和原版 src/index.ts 的输出逻辑保持一致

    write(
        'profile-green-animate.svg',
        create.createSvg(
            info,
            normalSettings,
            true,
        ),
    );

    write(
        'profile-green.svg',
        create.createSvg(
            info,
            normalSettings,
            false,
        ),
    );

    write(
        'profile-season-animate.svg',
        create.createSvg(
            info,
            template.NorthSeasonSettings,
            true,
        ),
    );

    write(
        'profile-season.svg',
        create.createSvg(
            info,
            template.NorthSeasonSettings,
            false,
        ),
    );

    write(
        'profile-south-season-animate.svg',
        create.createSvg(
            info,
            template.SouthSeasonSettings,
            true,
        ),
    );

    write(
        'profile-south-season.svg',
        create.createSvg(
            info,
            template.SouthSeasonSettings,
            false,
        ),
    );

    write(
        'profile-night-view.svg',
        create.createSvg(
            info,
            template.NightViewSettings,
            true,
        ),
    );

    write(
        'profile-night-green.svg',
        create.createSvg(
            info,
            template.NightGreenSettings,
            true,
        ),
    );

    write(
        'profile-night-rainbow.svg',
        create.createSvg(
            info,
            template.NightRainbowSettings,
            true,
        ),
    );

    write(
        'profile-gitblock.svg',
        create.createSvg(
            info,
            template.GitBlockSettings,
            true,
        ),
    );

    console.log(
        `Generated original-style SVGs in ${outputDir}`,
    );
}

main().catch((error) => {
    console.error(error);

    process.exitCode = 1;
});
