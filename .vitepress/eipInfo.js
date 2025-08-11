import grayMatter from 'gray-matter';
import yaml from 'js-yaml';
import git from 'isomorphic-git';
import fs from 'fs/promises';
import options from './options';

// Generate js-yaml engine that will never throw an error

let yamlEngine = (str) => {
    try {
        let data = yaml.load(str);

        // Fix typo'd dates
        // Can be removed once https://github.com/ethereum/EIPs/pull/7358 is merged
        for (let key in data) {
            let value = data[key];
            if (/^\d+-\d+-\d+$/.test(value)) {
                let dateComponents = value.split('-');
                let year = parseInt(dateComponents[0]);
                let month = parseInt(dateComponents[1]);
                let day = parseInt(dateComponents[2]);
                // Create a date object
                let date = new Date(year, month - 1, day);
                // If the date is valid, assign it
                if (!isNaN(date.getTime())) {
                    data[key] = date
                }
            }
        }

        return data;
    } catch (e) {
        return null;
    }
};

// Helpers

function getEipNumber(file) {
    // Get regex match
    return options.regexes.eip.exec(file)?.[0];
}

function formatDateString(date) {
    if (typeof date == 'string') date = new Date(date);
    return date.toISOString().split('T')[0];
}

function formatDateStringSlashSeperated(date) {
    if (typeof date == 'string') date = new Date(date);
    return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
}

async function parseAuthorData(authorData) {
    let authors = [];
    let rawAuthorRegex = [...authorData.matchAll(options.regexes.author)];
    await Promise.all(rawAuthorRegex.map(async (author) => {
        authors.push({
            name: author[1],
            githubData: author[2],
            emailData: author[3]
        });
    }));
    return authors;
}

async function getFileStateChanges({
    fs,
    dir = undefined,
    gitdir,
    cache = {},
    treeCurr,
    treePrev,
    textHeuristic = content => content.slice(0, Math.max(Math.min(8000, content.length - 1), 0)).every(x => x !== 0),
    decoder = new TextDecoder("utf-8"),
}) {
    if (treePrev != undefined) {
        let initialResult = await git.walk({
            fs,
            dir,
            gitdir,
            cache,
            trees: [treeCurr, treePrev],
            map: async function(path, [curr, prev]) {
                // ignore directories
                let typePromises = await Promise.all([
                    curr ? curr.type() : new Promise(resolve => resolve(undefined)),
                    prev ? prev.type() : new Promise(resolve => resolve(undefined)),
                ]);
                if (path === '.' || typePromises[0] !== 'blob' || typePromises[1] !== 'blob') return undefined;

                // Detect additions or removals
                if (!curr) return {
                    type: 'remove',
                    currPath: undefined,
                    prevPath: path,
                    curr: undefined,
                    prev,
                };
                if (!prev) return {
                    type: 'add',
                    currPath: path,
                    prevPath: undefined,
                    curr,
                    prev: undefined,
                };

                // no change, no modification
                if (await curr.oid() == await prev.oid()) return undefined;
    
                // There's been a change
                return {
                    type: 'modify',
                    currPath: path,
                    prevPath: path,
                    curr,
                    prev,
                };
            },
        });
        let added = initialResult.filter(patch => patch.type === 'add');
        let removed = initialResult.filter(patch => patch.type === 'remove');
        let matches = {};
        for (let { curr, currPath } of added) {
            let currContent = await curr.content();
            if (!textHeuristic(currContent)) return;
            let currDecoded = decoder.decode(currContent);
            let currLines = new Set(currDecoded.split('\n'));
            for (let { prev, prevPath } of removed) {
                let prevContent = await prev.content();
                if (!textHeuristic(prevContent)) return;
                let prevDecoded = decoder.decode(prevContent);
                let prevLines = new Set(prevDecoded.split('\n'));

                let intersection = currLines.intersection(prevLines);
                let totalLines = currLines.size + prevLines.size - intersection.size;
                let commonLines = intersection.size;
                let sharedFraction = commonLines / totalLines;

                if (sharedFraction >= 0.5) {
                    if (!(currPath in matches)) {
                        matches[currPath] = new Set()
                    }
                    matches[currPath].add({
                        prevPath,
                        sharedFraction,
                        curr,
                        prev,
                    });
                }
            }
        }
        // Greedy: pick highest sharedFraction
        let finalResult = [];
        let currPathsMatched = new Set();
        let prevPathsMatched = new Set();
        while (Object.keys(matches).length !== 0) {
            let bestCurrPath = undefined, bestPrevPath = undefined, bestCurr, bestPrev, bestSharedFraction = 0;
            for (let currPath of Object.keys(matches)) {
                for (let { prevPath, sharedFraction, curr, prev } of matches[currPath]) {
                    if (sharedFraction > bestSharedFraction) {
                        bestPrevPath = prevPath;
                        bestCurrPath = currPath;
                        bestCurr = curr;
                        bestPrev = prev;
                        bestSharedFraction = sharedFraction;
                    }
                }
            }
            if (bestCurrPath == undefined) break;
            currPathsMatched.add(bestCurrPath);
            prevPathsMatched.add(bestPrevPath);
            delete matches[bestCurrPath];
            for (let currPath of Object.keys(matches)) {
                matches[currPath] = new Set([...matches[currPath]].filter(itm => itm.prevPath !== bestPrevPath));
            }
            finalResult.push({
                type: 'renamed',
                currPath: bestCurrPath,
                prevPath: bestPrevPath,
                curr: bestCurr,
                prev: bestPrev,
            });
        }
        for (let itm of initialResult) {
            if (itm.currPath in currPathsMatched) continue;
            if (itm.prevPath in prevPathsMatched) continue;
            finalResult.push(itm);
        }

        return finalResult;
    } else {
        return git.walk({
            fs,
            dir,
            gitdir,
            cache,
            trees: [treeCurr],
            map: async function(path, [curr]) {
                // ignore directories
                if (
                    path === '.' ||
                    (curr && await curr.type().then(type => type !== 'blob'))
                ) return undefined;

                return {
                    type: 'add',
                    currPath: path,
                    prevPath: undefined,
                    curr,
                    prev: undefined
                };
            },
        });
    }
}

let eipInfo = {}; // EIP "number" => gray-matter data and content
let aliases = {}; // Alias => EIP "number"

let repoPaths = await fs.readdir('./.git/modules');

let allCommits = [];

let canSkipEip = {}; // Set to true once we've got all the data we need for an EIP

let cache = {};

for (let repoPath of repoPaths) {
    let gitdir = `./.git/modules/${repoPath}`;

    let commit = await git.log({
        fs,
        gitdir,
        cache,
        depth: 1,
    }).then(res => res[0]);

    do {
        let theDate = new Date();
        theDate.setTime(commit.commit.committer.timestamp * 1000);
        allCommits.push([repoPath, commit, theDate]);
        commit = await git.readCommit({
            fs,
            gitdir,
            cache,
            oid: commit.commit.parent[0],
        });
    } while (commit.commit.parent.length > 0)
}

allCommits.sort((a, b) => b[2].getTime() - a[2].getTime());

// Walk it back
let decoder = new TextDecoder("utf-8");
let i = 0;
for (let [repoPath, commit, commitDate] of allCommits) {
    if (i % 100 == 0) {
        console.log(`Done ${i} / ${allCommits.length} (${i / allCommits.length * 100}%)`)
    }
    i++;

    let gitdir = `./.git/modules/${repoPath}`;

    let patches = await getFileStateChanges({
        fs,
        gitdir,
        cache,
        treeCurr: git.TREE({ ref: commit.oid }),
        treePrev: commit.commit.parent.length > 0 ? git.TREE({ ref: commit.commit.parent[0] }) : undefined,
    });

    try {
        // Alias management
        // If 1 delete and 1 add, add an alias from the deleted file to the added file
        // If rename, add an alias from the old file to the new file
        // If delete, add an alias to null
        let added = patches.filter(patch => patch.type === 'add');
        let deleted = patches.filter(patch => patch.type === 'remove');
        let renamed = patches.filter(patch => patch.type === 'rename');
        let modified = patches.filter(patch => patch.type === 'modifiy');
        for (let patch of deleted) {
            let oldEip = getEipNumber(patch.currPath);
            if (oldEip && !(oldEip in aliases)) aliases[oldEip] = null;
        }
        for (let patch of renamed) {
            let oldEip = getEipNumber(patch.prevPath);
            let newEip = getEipNumber(patch.currPath);
            if (oldEip == newEip) continue; // Ignore renames that don't change the EIP number, if this ever happens
            if (oldEip && !(oldEip in aliases)) aliases[oldEip] = newEip;
        }
        // Process the files
        await Promise.all(added.concat(modified).map(async (patch) => {
            let eip = getEipNumber(patch.currPath);
            while (eip in aliases) {
                eip = aliases[eip];
            }
            if (canSkipEip[eip]) return; // We've already got all the data we need for this EIP
            let isAdded = patch.type === 'add';
            if (eip) {
                // Initialize the gray matter data
                let gmNew, gmOld = null;

                // Read both files' contents
                let contentNew = decoder.decode(await patch.curr.content());
                gmNew = grayMatter(contentNew, {
                    engines: {
                        yaml: yamlEngine
                    }
                });

                if (gmNew == null) return; // An error occurred while parsing the yaml, skip this file

                if (gmNew.data['status'] == 'Moved') return; // Skip stubs

                let needFetchOld = !isAdded && (!gmNew.data['last-status-change'] || (['Final', 'Living'].includes(gmNew.data['status']) && !gmNew.data['finalized']));

                if (needFetchOld) {
                    let contentOld = decoder.decode(await patch.prev.content());
                    gmOld = grayMatter(contentOld, {
                        engines: {
                            yaml: yamlEngine
                        }
                    });
                }

                let canUseOld = isAdded || gmOld != null;

                // Add missing fields
                let data = eipInfo[eip]?.data ?? gmNew.data;

                if (!('eip' in data)) data['eip'] = eip;

                let datesToAdd = {
                    'last-updated': true,
                    'created': isAdded,
                    'last-status-change': gmNew.data['status'] != gmOld?.data?.['status'] && canUseOld,
                    'finalized': ['Final', 'Living'].includes(gmNew.data['status']) && !(['Final', 'Living'].includes(gmOld?.data?.['status'])) && canUseOld,
                };
                let theSha = commit.oid;
                for (let prop in datesToAdd) {
                    if (datesToAdd[prop] && !(prop in data)) data[prop] = commitDate;
                    if (datesToAdd[prop] && !(`${prop}-commit` in data)) data[`${prop}-commit`] = theSha;
                }

                // Save
                eipInfo[eip] = {
                    data,
                    content: eipInfo[eip]?.content ?? gmNew.content
                };

                // If we have all the data we need, we can skip this EIP future commits
                if (
                    ('eip' in data) &&
                    ('last-updated' in data) &&
                    ('created' in data) &&
                    ('last-status-change' in data) &&
                    ('finalized' in data || !(['Final', 'Living'].includes(data['status']))) &&
                    ('type' in data) // Something that can only be fetched from the front matter, to make sure that it's been parsed
                ) canSkipEip[eip] = true;
            }
        }));
    } catch (e) {
        // Add debugging info

        // Include commit printout
        console.error(`Commit: ${commit.oid}`);
        console.error(`Author: ${commit.commit.author.name} <${commit.commit.author.email}>`);
        console.error(`Date: ${commit.commit.committer.timestamp}`);
        console.error(`Message: ${commit.commit.message}`);

        // Get list of changed files
        for (let patch of patches) {
            for (let patch of await diff.patches()) {
                console.error(`New File: ${patch.currPath}`);
                console.error(`Old File: ${patch.prevPath}`);
                console.error(`Type: ${patch.type}`);
            }
        }

        // Re-throw
        throw e;
    }
}

// Now make the necessary transformations
for (let eip in eipInfo) {
    try {
        // Load the data
        let data = eipInfo[eip].data;

        // Transform title
        if (data['title']) data['title'] = `${data['category'] == 'ERC' ? 'ERC' : 'EIP'}-${eip}: ${data['title']}`

        // Transform authors
        if (data['author']) data['author'] = await parseAuthorData(data['author']);

        // Provide slash versions of dates
        if (data['last-updated']) data['last-updated-slash'] = formatDateStringSlashSeperated(data['last-updated']);
        if (data['last-status-change']) data['last-status-change-slash'] = formatDateStringSlashSeperated(data['last-status-change']);
        if (data['created']) data['created-slash'] = formatDateStringSlashSeperated(data['created']);
        if (data['finalized']) data['finalized-slash'] = formatDateStringSlashSeperated(data['finalized']);

        // And stringify original versions
        if (data['last-updated']) data['last-updated'] = formatDateString(data['last-updated']);
        if (data['last-status-change']) data['last-status-change'] = formatDateString(data['last-status-change']);
        if (data['created']) data['created'] = formatDateString(data['created']);
        if (data['finalized']) data['finalized'] = formatDateString(data['finalized']);


        // Save the data
        eipInfo[eip].data = data;
    } catch (e) {
        // Add debugging info
        console.error(`EIP: ${eip}`);
        console.error(`Data: ${JSON.stringify(eipInfo[eip].data, null, 2)}`);

        // Re-throw
        throw e;
    }
}

delete eipInfo['2535'] // Doesn't use relative links.
delete eipInfo['7818'] // README in assets doesn't work properly

delete eipInfo['777']  // Could not resolve "./../assets/eip-777/logo/png/ERC-777-logo-beige-48px.png" from "src/eip/777.md"
delete eipInfo['1822'] // Could not resolve "../assets/eip-1822/proxy-diagram.png" from "src/eip/1822.md"
delete eipInfo['3450'] // Could not resolve "./../assets/eip-3450/lagrange.gif" from "src/eip/3450.md"

// Rewrite links
for (let eip in eipInfo) {
    let content = eipInfo[eip].content;
    // Regex to match links
    let regex = /\[([^\]]*)\]\(([^)]+)\)/g;
    let match;
    while ((match = regex.exec(content)) != null) {
        if (match[2].toLowerCase().startsWith("../assets/eip-")) {
            // ../assets/eip-<eip>/<assetPa/th>
            let assetPath = `../public/eip/${eip}/${match[2].substring(15 + eip.length)}`;
            content = content.replace(match[0], `[${match[1]}](${assetPath})`);
        } else if (match[2].toLowerCase().startsWith("../assets/erc-")) {
            // ../assets/eip-<eip>/<assetPa/th>
            let assetPath = `../public/eip/${eip}/${match[2].substring(15 + eip.length)}`;
            content = content.replace(match[0], `[${match[1]}](${assetPath})`);
        } else if (match[2].startsWith("./eip-")) {
            let linkedEip = match[2].split('eip-')[1].split('.')[0];
            content = content.replace(match[0], `[${match[1]}](./${linkedEip}.md)`);
        } else if (match[2].startsWith("./erc-")) {
            let linkedEip = match[2].split('erc-')[1].split('.')[0];
            content = content.replace(match[0], `[${match[1]}](./${linkedEip}.md)`);
        } else if (match[2].startsWith("../LICENSE")) {
            content = content.replace(match[0], `[${match[1]}](../LICENSE.md)`);
        } else if (match[2].startsWith("../config/")) {
            // Strip the link. It ain't needed. Why do you have to do this to me, EIP-7329?
            content = content.replace(match[0], match[1]);
        }
    }
    // Reassign
    eipInfo[eip].content = content;
}

export default eipInfo;

export { aliases };
