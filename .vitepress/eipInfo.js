import grayMatter from 'gray-matter';
import yaml from 'js-yaml';
import git from 'isomorphic-git';
import fs from 'node:fs';
import http from 'node:http';

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
    if (!file.startsWith('EIPS/')) return null; // Ignore non-EIP files
    let eip = file.match(/(?<=eip-)\w+(?=(?:.\w+)$)/gi)?.pop();
    return eip;
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
    let rawAuthorRegex = authorData.match(/(?<=^|,\s*)[^\s]([^,"]|".*")+(?=(?:$|,))/g);
    await Promise.all(rawAuthorRegex.map(async (author) => {
        let authorName = author.match(/(?<![(<].*)[^\s(<][^(<]*\w/g);
        let emailData = author.match(/(?<=\<).*(?=\>)/g);
        let githubData = author.match(/(?<=\(@)[\w-]+(?=\))/g);
        let authorObj = {
            name: authorName.pop()
        };
        if (emailData) authorObj.email = emailData.pop();
        if (githubData) authorObj.github = githubData.pop();
        authors.push(authorObj);
    }));
    return authors;
}

async function getFileStateChanges({
    fs,
    dir,
    gitdir,
    commitHash1,
    commitHash2
}) {
    return git.walk({
        fs,
        dir,
        gitdir,
        trees: [git.TREE({ ref: commitHash1 }), git.TREE({ ref: commitHash2 })],
        map: async function(filepath, [A, B]) {
            // ignore directories
            if (filepath === '.') {
                return
            }
            if ((await A.type()) === 'tree' || (await B.type()) === 'tree') {
                return
            }
  
            // generate ids
            const Aoid = await A.oid()
            const Boid = await B.oid()
  
            // determine modification type
            let type = 'equal'
            if (Aoid !== Boid) {
                type = 'modify'
            }
            if (Aoid === undefined) {
                type = 'add'
            }
            if (Boid === undefined) {
                type = 'remove'
            }
            if (Aoid === undefined && Boid === undefined) {
                console.log('Something weird happened:')
                console.log(A)
                console.log(B)
            }
  
            return {
                path: `/${filepath}`,
                type: type,
            }
        },
    })
}

let dir = "EIPS";
let gitdir = "./.git/modules/EIPs";

let eipInfo = {}; // EIP "number" => gray-matter data and content
let aliases = {}; // Alias => EIP "number"

let canSkipEip = {}; // Set to true once we've got all the data we need for an EIP

let files = await git.listFiles({ fs, dir, gitdir });

let textDecoder = new TextDecoder("utf-8");

for (let file of files) {
    let eip = getEipNumber(file);
    if (!eip) continue; // Ignore non-EIP files

    // Get log for this file
    let log = await git.log({ fs, dir, gitdir, filepath: file, follow: true });

    // Sort log, descending by timestamp
    log.sort((a, b) => b.committer.timestamp - a.committer.timestamp);

    // Track filepath
    let filepath = file;

    let lastCommit = null;

    for (let commit of log) {
        // Get file status changes
        let fileStateChanges = await getFileStateChanges({
            fs,
            dir,
            gitdir,
            commitHash1: commit.oid,
            commitHash2: commit.parents[0]?.oid
        });

        // If the file was renamed, update the filepath
        // TODO: There has to be a better way to do this
        let additions = fileStateChanges.filter(change => change.type == 'add');
        let removals = fileStateChanges.filter(change => change.type == 'remove');
        if (additions.length == 1 && removals.length == 1) {
            filepath = additions[0].path; // Since this is in our log, we know that the file was renamed
        } else if (removals.filter(change => change.path == filepath).length == 1) break; // If the file was deleted, break

        // Get the file contents
        let { blob } = await git.readBlob({ fs, dir, gitdir, oid: commit.oid, filepath });

        // Turn Uint8Array into string
        let content = textDecoder.decode(blob);

        // Parse the front matter
        let gm = grayMatter(content, {
            engines: {
                yaml: yamlEngine
            }
        });

        // If the front matter is invalid, skip this commit
        if (gm == null) continue;

        // Get existing data
        let data = eipInfo[eip]?.data ?? gm.data;

        // Add missing fields
        if (!('eip' in data)) data['eip'] = eip;
        
        let datesToAdd = {
            'last-updated': true,
            'created': commit.oid == log[log.length - 1].oid,
            'last-status-change': gm.data['status'] != eipInfo[eip]?.data?.['status'] && eipInfo[eip]?.data?.['status'] != null,
            'finalized': ['Final', 'Living'].includes(gm.data['status']) && !(['Final', 'Living'].includes(eipInfo[eip]?.data?.['status'])) && eipInfo[eip]?.data?.['status'] != null,
        };

        let theDate = commit.committer.timestamp * 1000;
        let theSha = commit.oid;
        for (let prop in datesToAdd) {
            if (datesToAdd[prop] && !(prop in data)) data[prop] = theDate;
            if (datesToAdd[prop] && !(`${prop}-commit` in data)) data[`${prop}-commit`] = theSha;
        }

        lastCommit = commit;
    }
}


let allCommits = await git.log({
    fs,
    dir,
    gitdir
});

// Sort descending by timestamp
allCommits.sort((a, b) => b.committer.timestamp - a.committer.timestamp);

// Walk it back
for (commit of allCommits) {
    try {
        // Get the changes made in this commit
        let tree = await commit.getTree({
            fs,
            dir,
            gitdir,
            oid: commit.commit.tree
        });
        let parentTree = await commit.getParents()[0]?.getTree({
            fs,
            dir,
            gitdir,
            oid: commit.getParents()[0]?.commit.tree
        });
        let diffs = await commit.getDiff();
        let patches = [];
        for (let diff of diffs) {
            patches.push(...(await diff.patches()));
        }

        // Alias management
        // If 1 delete and 1 add, add an alias from the deleted file to the added file
        // If rename, add an alias from the old file to the new file
        // If delete, add an alias to null
        let added = patches.filter(patch => patch.isAdded());
        let deleted = patches.filter(patch => patch.isDeleted());
        let renamed = patches.filter(patch => patch.isRenamed());
        let modified = patches.filter(patch => patch.isModified() && !patch.isAdded() && !patch.isDeleted());
        if (added.length == 1 && deleted.length == 1) {
            // Make sure they are both EIPs!
            if (getEipNumber(added[0].newFile().path()) && getEipNumber(deleted[0].oldFile().path())) {
                // Make a fake patch that "renames" the deleted file to the added file
                let theOldFile = deleted[0].oldFile();
                let patch = added[0];
                patch.oldFile = () => theOldFile;
                patch.isRenamed = () => true;
                patch.isModified = () => true;
                patch.isAdded = () => false;
                patch.isDeleted = () => false;
                patch.status = () => 0;
                renamed.push(patch);
                added = [];
                deleted = [];
            }
        }
        for (let patch of deleted) {
            let oldEip = getEipNumber(patch.newFile().path());
            if (oldEip && !(oldEip in aliases)) aliases[oldEip] = null;
        }
        for (let patch of renamed) {
            let oldEip = getEipNumber(patch.oldFile().path());
            let newEip = getEipNumber(patch.newFile().path());
            if (oldEip == newEip) continue; // Ignore renames that don't change the EIP number, if this ever happens
            if (oldEip && !(oldEip in aliases)) aliases[oldEip] = newEip;
        }
        // Process the files
        await Promise.all(added.concat(modified).map(async (patch) => {
            let eip = getEipNumber(patch.newFile().path());
            while (eip in aliases) {
                eip = aliases[eip];
            }
            if (canSkipEip[eip]) return; // We've already got all the data we need for this EIP
            let isAdded = patch.isAdded();
            if (eip) {
                // Initialize the gray matter data
                let gmNew, gmOld = null;

                // Read both files' contents
                let objectIdNew = patch.newFile().id();
                let blobNew = await repo.getBlob(objectIdNew);
                let contentNew = blobNew.toString();
                gmNew = grayMatter(contentNew, {
                    engines: {
                        yaml: yamlEngine
                    }
                });

                if (gmNew == null) return; // An error occurred while parsing the yaml, skip this file

                let needFetchOld = !isAdded && (!gmNew.data['last-status-change'] || (['Final', 'Living'].includes(gmNew.data['status']) && !gmNew.data['finalized']));

                if (needFetchOld) {
                    let objectIdOld = patch.oldFile().id();
                    let blobOld = await repo.getBlob(objectIdOld);
                    let contentOld = blobOld.toString();
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
                let theDate = commit.date();
                let theSha = commit.sha();
                for (let prop in datesToAdd) {
                    if (datesToAdd[prop] && !(prop in data)) data[prop] = theDate;
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
        console.error(`Commit: ${commit.sha()}`);
        console.error(`Author: ${commit.author().name()} <${commit.author().email()}>`);
        console.error(`Date: ${commit.date()}`);
        console.error(`Message: ${commit.message()}`);

        // Get list of changed files
        let diffs = await commit.getDiff();
        for (let diff of diffs) {
            for (let patch of await diff.patches()) {
                console.error(`New File: ${patch.newFile()?.path()}`);
                console.error(`Old File: ${patch.oldFile()?.path()}`);
                console.error(`Type: ${patch.isAdded() ? 'Added' : patch.isDeleted() ? 'Deleted' : patch.isRenamed() ? 'Renamed' : patch.isCopied() ? 'Copied' : patch.isModified() ? 'Modified' : 'Unknown'}`);
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
        } else if (match[2].startsWith("./eip-")) {
            let linkedEip = match[2].split('eip-')[1].split('.')[0];
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
