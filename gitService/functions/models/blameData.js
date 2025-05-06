class BlameData {
    constructor({ author, commitHash, date }) {
        this.author = author;
        this.commitHash = commitHash;
        this.date = date;
    }
}

module.exports = BlameData;
