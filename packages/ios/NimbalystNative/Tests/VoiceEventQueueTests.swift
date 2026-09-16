import XCTest
@testable import NimbalystNative

final class VoiceEventQueueTests: XCTestCase {
    func testQuestionsLeadCoalescedCompletionsAndReplaysStayPresented() {
        func event(_ id: String, _ kind: String, session: String = "s") -> VoiceSourceEvent {
            .init(eventId: id, kind: kind, sessionId: session, hostDeviceId: "host", projectId: "/project", taskId: "task", revision: 1, promptId: kind == "question" ? id : nil, label: "Session", summary: "result")
        }
        var queue = VoiceEventQueue()
        queue.enqueue(event("old", "completion"))
        queue.enqueue(event("new", "completion"))
        queue.enqueue(event("q1", "question", session: "other"))
        queue.enqueue(event("q2", "question", session: "third"))
        XCTAssertEqual(queue.events.map(\.id), ["q1", "q2", "new"])
        queue.markPresented("q1")
        queue.enqueue(event("q1", "question", session: "other"))
        XCTAssertEqual(queue.events.map(\.id), ["q2", "new"])
    }
}
