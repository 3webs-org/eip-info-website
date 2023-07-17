import fs from 'node:fs/promises';

import yaml from 'js-yaml';
import grayMatter from 'gray-matter';

import Git from 'nodegit';

import { tmpdir } from 'node:os';
import uuid from 'uuid';

import config from '../config.js'

let temporary = tmpdir() + "/" + uuid.v1() + '/EIPs';
console.log(`Cloning ${config.git} to ${temporary}`);
let repo = await Git.Clone(config.git, temporary);
console.log(`Cloned ${config.git} to ${temporary}`);

function getEipNumber(file) {
    return file.match(/(?<=eip-)\w+$/gi).pop();
}

let eipInfo = {}; // EIP "number" => gray-matter data and content
let aliases = {}; // Alias => EIP "number"

let commit = await repo.getHeadCommit();
console.log(commit.message())
console.log(await Promise.all(((await (await repo.getHeadCommit()).getDiff()).map(async diff => (await diff.patches()).map(async patch => {
    return {
        oldFile: patch.oldFile(),
        newFile: patch.newFile(),
        added: patch.isAdded(),
        deleted: patch.isDeleted(),
        modified: patch.isModified(),
        renamed: patch.isRenamed(),
    }
})))))

// Walk it back
while (commit) {
    // Get the changes made in this commit
    let diffs = await commit.getDiff();
    for (let diff of diffs) {
        let patches = await diff.patches();
        // Alias management
        // If 1 delete and 1 add, add an alias from the deleted file to the added file
        // If rename, add an alias from the old file to the new file
        // If delete, add an alias to null
        let added = patches.filter(patch => patch.isAdded());
        let deleted = patches.filter(patch => patch.isDeleted());
        let renamed = patches.filter(patch => patch.isRenamed());
        if (added.length == 1 && deleted.length == 1) {
            let oldEip = getEipNumber(deleted[0].newFile().path());
            let newEip = getEipNumber(added[0].newFile().path());
            aliases[oldEip] = newEip;
        } else {
            if (deleted > 0) {
                for (let patch of deleted) {
                    let oldEip = getEipNumber(patch.newFile().path());
                    aliases[oldEip] = null;
                }
            }
            if (renamed > 0) {
                for (let patch of renamed) {
                    let oldEip = getEipNumber(patch.oldFile().path());
                    let newEip = getEipNumber(patch.newFile().path());
                    aliases[oldEip] = newEip;
                }
            }
        }
        // For every added EIP
    }

    // Walk through the commit's parents
    commit = await commit.getParents().then(parents => parents[0]);
}


export async function fetchEips() {
    let eipsDir = await fs.readdir('./EIPs/EIPS');
    let eipsUnsorted = await Promise.all(eipsDir.map(getEipTransformedPremable));
    return eipsUnsorted.sort(sortEips);
}

export async function getEipTransformedPremable(file) {
    let eipFile = await fs.readFile(`./EIPs/EIPS/${file}`, 'utf-8');
    try {
        let eipContent = await fs.readFile(`./EIPs/EIPS/${file}`, 'utf-8');
        let eipData = (grayMatter(eipContent)).data;
        
        let newEipData = { ...eipData };

        newEipData.eip = await filenameToEipNumber(file);

        if (!newEipData.created) {
            newEipData.created = await getCreatedDate(`EIPs/EIPS/${file}`);
        }

        if (!newEipData.lastStatusChange) {
            newEipData.lastStatusChange = await getLatestStatusChange(`EIPs/EIPS/${file}`);
        }

        if (!newEipData.finalized) {
            newEipData.finalized = newEipData.lastStatusChange;
        }

        newEipData.authorData = await parseAuthorData(eipData.author);

        newEipData.lastStatusChange = formatDateString(lastStatusChange);
        newEipData.created = formatDateString(created);
        newEipData.relativePath = `EIPS/${file}`;

        newEipData.link = `/EIPs/EIPS/eip-${newEipData.eip}`;

        newEipData.createdSlashSeperated = formatDateStringSlashSeperated(created);

        if (eipData.status === 'Final' || eipData.status === 'Living') {
            newEipData.finalized = formatDateString(lastStatusChange);
            newEipData.finalizedSlashSeperated = formatDateStringSlashSeperated(lastStatusChange);
        }

        if (newEipData.eip == 1) {
            newEipData = { ...newEipData, ...(await getEip1Data()) };
        }

        return newEipData;
    } catch (error) {
        console.error(`Error while parsing ${file}`);
        throw error;
    }
}

export async function filenameToEipNumber(filename) {
    return filename.toLowerCase().match(/(?<=eip-)\d+/g).pop();
}

export async function parseAuthorData(authorData) {
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

export async function getCreatedDate(relativePath) {
    let gitLogAdded = await git.log(['--diff-filter=A', '--', relativePath]);
    return new Date(gitLogAdded.latest.date);
}

export async function getLatestStatusChange(relativePath) {
    let gitBlame = await git.raw(['blame', relativePath]);
    let gitBlameLines = gitBlame.split('\n');
    let lastStatusChange = gitBlameLines.filter(line => line.match(/status:/gi))?.pop()?.match(/(?<=\s)\d+-\d+-\d+/g)?.pop();
    return new Date(lastStatusChange);
}

export async function getEip1Data() {
    let editorfile = await fs.readFile('./config/eip-editors.yml', 'utf8');
    let editordata = yaml.load(editorfile);
    let editorUsernames = [];
    let inactiveEditorUsernames = [];
    for (let editorType in editordata) {
        for (let editor of editordata[editorType]) {
            if (editorUsernames.includes(editor)) continue;

            if (editorType === 'inactive') {
                inactiveEditorUsernames.push(editor);
            } else {
                editorUsernames.push(editor);
            }
        }
    }

    let editors = [];
    for (let username of editorUsernames) {
        let editorTypes = [];
        for (let editorType in editordata) {
            if (editordata[editorType].includes(username)) {
                editorTypes.push(editorType.charAt(0).toUpperCase() + editorType.slice(1));
            }
        }
        editors.push({
            avatar: `https://github.com/${username}.png`,
            name: username,
            title: editorTypes.join(', '),
            links: [
                { icon: 'github', link: `https://github.com/${username}` }
            ]
        });
    }

    let emeritusEditors = [];
    for (let username of inactiveEditorUsernames) {
        emeritusEditors.push({
            avatar: `https://github.com/${username}.png`,
            name: username,
            title: 'Emeritus Editor',
            links: [
                { icon: 'github', link: `https://github.com/${username}` }
            ]
        });
    }

    return {
        editors,
        emeritusEditors
    }
}

export function sortEips(a, b) {
    // If both EIP numbers are strings and can't be turned to integers, sort by creation date
    if (isNaN(parseInt(a.eip)) && isNaN(parseInt(b.eip))) {
        return a.lastStatusChange - b.lastStatusChange;
    }
    // If only one of the EIP numbers is a string, sort the string to the end
    if (isNaN(parseInt(a.eip))) {
        return 1;
    }
    if (isNaN(parseInt(b.eip))) {
        return -1;
    }
    // If both EIP numbers are integers, sort by EIP number
    return a.eip - b.eip;
}


function formatDateString(date) {
    return date.toISOString().split('T')[0];
}

function formatDateStringSlashSeperated(date) {
    return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
}
