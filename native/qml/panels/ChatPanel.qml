import QtQuick
import QtQuick.Layouts
import CloseNI

PanelPlaceholder {
    name: "Chat"
    source: "desktop/renderer/plan.js"

    // The getting-started guide sits above the chat it is teaching.
    OnboardingGuide { Layout.fillWidth: true }
}
