export default {
    "statuses": [
        "Living", "Last Call", "Final", "Review", "Draft", "Stagnant", "Withdrawn", "Moved", "Abandoned"
    ],
    "types": [
        "Standards Track",
        "Informational",
        "Meta"
    ],
    "categories": {
        "Standards Track": [
            "Core",
            "ERC",
            "Interface",
            "Networking",
        ],
    },
    "regexes": {
        "eip": /(?<=^(?:(?:EIPS\/eip)|(?:ERCS\/erc))-)[\w_]+(?=\.md$)/gm, // Matches the EIP number, or nothing if it's not an EIP
        "prefix": /(?<=^)(EIP|ERC)(?=S\/(?:(?:(?<=EIPS\/)eip)|(?:(?<=ERCS\/)erc))-[\w_]+\.md)/gm, // Matches the EIP prefix (EIP or ERC), or nothing if it's not an EIP
        "author": /(?<=(?:^|(?:,\s*)))([^\s].*?)(?:\s+\(@(\w+)\))?(?:\s+<((?:(?:[\w.%+-]+)|(?:"[^"]+"))@(?:(?:\w+(?:[-_]*\w+)*(?:\.\w+(?:[-_]*\w+)*)*)|\[(?:(?:(?:25[0-5]|2[0-4]\d|[0-1]?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|[0-1]?\d?\d)){3})|(?:(?:[a-fA-F\d]{1,4}:){7}[a-fA-F\d]{1,4}))\]))>)?(?=$|,)/gm, // Matches individual author strings. First group is the name, second group is the optional github, third group is the optional email address
    }
};
