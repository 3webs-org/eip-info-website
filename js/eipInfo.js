import grayMatter from 'gray-matter';
import yaml from 'js-yaml';
import Git from 'nodegit';

// Generate js-yaml engine that will never throw an error

let yamlEngine = (str) => {
    try {
        let data = yaml.load(str);
        return data;
    } catch (e) {
        return null;
    }
};

// Helpers

function getEipNumber(file) {
    return file.match(/(?<=eip-)\w+(?=(?:.\w+)$)/gi)?.pop();
}

function formatDateString(date) {
    return date.toISOString().split('T')[0];
}

function formatDateStringSlashSeperated(date) {
    return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
}

async function parseAuthorData(authorData) {
    let authors = [];
    for (let author of authorData.match(/(?<=^|,\s*)[^\s]([^,"]|".*")+(?=(?:$|,))/g)) {
        let authorName = author.match(/(?<![(<].*)[^\s(<][^(<]*\w/g);
        let emailData = author.match(/(?<=\<).*(?=\>)/g);
        let githubData = author.match(/(?<=\(@)[\w-]+(?=\))/g);
        if (emailData) {
            authors.push({
                name: authorName.pop(),
                email: emailData.pop()
            });
        } else if (githubData) {
            authors.push({
                name: authorName.pop(),
                github: githubData.pop()
            });
        } else {
            authors.push({
                name: authorName.pop()
            });
        }
    }
    return authors;
}

let repo = await Git.Repository.open("./.git/modules/EIPs");

let eipInfo = {}; // EIP "number" => gray-matter data and content
let aliases = {}; // Alias => EIP "number"

let commit = await repo.getHeadCommit();

// Walk it back
while (commit) {
    try {
        // Get the changes made in this commit
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
                let patch = added[0];
                patch.oldFile = () => deleted[0].oldFile();
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
        if (deleted > 0) {
            for (let patch of deleted) {
                let oldEip = getEipNumber(patch.newFile().path());
                if (!(oldEip in aliases)) aliases[oldEip] = null;
            }
        }
        if (renamed > 0) {
            for (let patch of renamed) {
                let oldEip = getEipNumber(patch.oldFile().path());
                let newEip = getEipNumber(patch.newFile().path());
                if (!(oldEip in aliases)) aliases[oldEip] = newEip;
            }
        }
        // If an EIP is added or modified, and does not have an alias, initialize its gray matter data, and add necessary fields
        for (let patch of added.concat(modified)) {
            let eip = getEipNumber(patch.newFile().path());
            if (eip && !(eip in aliases) && !(eip in eipInfo)) {
                // Read the file's contents
                let objectId = patch.newFile().id();
                let blob = await repo.getBlob(objectId);
                let content = blob.toString();
                let gm = grayMatter(content, {
                    engines: {
                        yaml: yamlEngine
                    }
                });

                if (gm == null) {
                    continue; // An error occurred while parsing the yaml, skip this file
                }

                // Add missing fields
                let data = gm.data;
                data['last-updated'] = commit.date();
                if (!data['eip']) data['eip'] = eip;
                gm.data = data;

                // Save
                eipInfo[eip] = gm;
            }
        }

        // Add-only cases
        for (let patch of added) {
            let eip = getEipNumber(patch.newFile().path());
            while (eip in aliases) eip = aliases[eip];
            if (eip && eip in eipInfo) {
                // Read the file's contents
                let objectId = patch.newFile().id();
                let blob = await repo.getBlob(objectId);
                let content = blob.toString();
                let gm = grayMatter(content, {
                    engines: {
                        yaml: yamlEngine
                    }
                });

                if (gm == null) {
                    continue; // An error occurred while parsing the yaml, skip this file
                }

                // Add missing fields
                let data = eipInfo[eip].data;
                if (['Final', 'Living'].includes(gm.data['status'])) data['finalized'] = commit.date();
                if (!data['last-status-change']) data['last-status-change'] = commit.date();
                if (!data['created']) data['created'] = commit.date();

                // Save
                eipInfo[eip].data = data;
            }
        }

        // Modify-only cases
        for (let patch of modified) {
            let eip = getEipNumber(patch.newFile().path());
            while (eip in aliases) eip = aliases[eip];
            if (eip && eip in eipInfo) {
                // Read both files' contents
                let objectIdNew = patch.newFile().id();
                let blobNew = await repo.getBlob(objectIdNew);
                let contentNew = blobNew.toString();

                let objectIdOld = patch.oldFile().id();
                let blobOld = await repo.getBlob(objectIdOld);
                let contentOld = blobOld.toString();

                let gmNew = grayMatter(contentNew, {
                    engines: {
                        yaml: yamlEngine
                    }
                });
                let gmOld = grayMatter(contentOld, {
                    engines: {
                        yaml: yamlEngine
                    }
                });

                if (gmNew == null || gmOld == null) {
                    continue; // An error occurred while parsing the yaml, skip this file
                }

                // Add missing fields
                let data = eipInfo[eip].data;
                if (['Final', 'Living'].includes(gmNew.data['status']) && !(['Final', 'Living'].includes(gmOld.data['status']))) data['finalized'] = commit.date();
                if (!data['last-status-change'] && gmNew.data['status'] != gmOld.data['status']) data['last-status-change'] = commit.date();

                // Save
                eipInfo[eip].data = data;
            }
        }
    } catch (e) {
        // Add debugging info

        // Include commit printout
        console.error(`Commit: ${commit.sha()}`);
        console.error(`Author: ${commit.author().name()} <${commit.author().email()}>`);
        console.error(`Date: ${commit.date()}`);
        console.error(`Message: ${commit.message()}`);

        // Get list of changed files
        let diffs = await commit.getDiff();
        let patches = [];
        for (let diff of diffs) {
            patches.push(...(await diff.patches()));
        }
        let changedFiles = patches.map(patch => patch.newFile().path());
        changedFiles.push(...patches.map(patch => patch.oldFile().path()));
        changedFiles = [...new Set(changedFiles)];
        console.error(`Changed files:`);
        for (let file of changedFiles) {
            console.error(`  ${file}`);
        }

        // Re-throw
        throw e;
    }

    // Walk through the commit's parents
    commit = await commit.getParents().then(parents => parents[0]);
}

// Now make the necessary transformations
for (let eip in eipInfo) {
    // Load the data
    let data = eipInfo[eip].data;

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
}

export default eipInfo;

console.log(eipInfo);
