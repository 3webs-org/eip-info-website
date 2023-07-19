import grayMatter from 'gray-matter';
import yaml from 'js-yaml';
import Git from 'nodegit';
import AsyncLock from 'async-lock';

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

let repo = await Git.Repository.open("./.git/modules/EIPs");

let eipInfo = {}; // EIP "number" => gray-matter data and content
let aliases = {}; // Alias => EIP "number"

let canSkipEip = {}; // Set to true once we've got all the data we need for an EIP

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

                if (!patch.isAdded()) {
                    let objectIdOld = patch.oldFile().id();
                    let blobOld = await repo.getBlob(objectIdOld);
                    let contentOld = blobOld.toString();
                    gmOld = grayMatter(contentOld, {
                        engines: {
                            yaml: yamlEngine
                        }
                    });
                }

                if (gmNew == null && !patch.isAdded()) {
                    return; // An error occurred while parsing the yaml, skip this file
                }

                // Add missing fields
                let data = eipInfo[eip]?.data ?? gmNew.data;
                if (
                    !('eip' in data)
                ) data['eip'] = eip;
                if (
                    !('last-updated' in data)
                ) data['last-updated'] = commit.date();
                if (
                    !('created' in data) &&
                    patch.isAdded()
                ) data['created'] = commit.date();
                if (
                    !('last-status-change' in data) &&
                    gmNew.data['status'] != gmOld?.data?.['status']
                ) data['last-status-change'] = commit.date();
                if (
                    !('finalized' in data) &&
                    ['Final', 'Living'].includes(gmNew.data['status']) && !(['Final', 'Living'].includes(gmOld?.data?.['status']))
                ) data['finalized'] = commit.date();

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

    // Walk through the commit's parents
    commit = await commit.getParents().then(parents => parents[0]);
}

// Now make the necessary transformations
for (let eip in eipInfo) {
    try {
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
    } catch (e) {
        // Add debugging info
        console.error(`EIP: ${eip}`);
        console.error(`Data: ${JSON.stringify(eipInfo[eip].data, null, 2)}`);

        // Re-throw
        throw e;
    }
}

// TODO: Temporarily nuke EIPs that are confirmed to break the build, as well as all unconfirmed EIPs
for (let eip in eipInfo) {
    if (parseInt(eip) != eip || parseInt(eip) < 5883) {
        delete eipInfo[eip];
    }
}
delete eipInfo['5988'];

// Rewrite links
for (let eip in eipInfo) {
    let content = eipInfo[eip].content;
    // Regex to match links
    let regex = /\[([^\]]*)\]\(([^)]+)\)/g;
    let match;
    while ((match = regex.exec(content)) != null) {
        if (match[2].startsWith("../assets/eip-")) {
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
        } else if (match[2].startsWith('.')) {
            throw new Error(`Unknown link: ${match[2]} at EIP ${eip}`);
        }
    }
    // Reassign
    eipInfo[eip].content = content;
}

export default eipInfo;

export { aliases };
