import { CAPACITY } from "./constants.js";
export class MessageBuffer {
    messages = [];
    push(msg) {
        this.messages.push(msg);
        if (this.messages.length > CAPACITY.MAX_BUFFER_MESSAGES) {
            this.messages = this.messages.slice(-Math.floor(CAPACITY.MAX_BUFFER_MESSAGES * 0.8));
        }
    }
    drain() {
        const copy = [...this.messages];
        this.messages = [];
        return copy;
    }
    get size() {
        return this.messages.length;
    }
    peek() {
        return [...this.messages];
    }
    clear() {
        this.messages = [];
    }
}
