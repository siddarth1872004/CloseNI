# The native Qt app (design: docs/superpowers/specs/2026-10-08-native-qt-design.md).
#
# Phase 0: a window that finds Node, spawns the agent and shows its `ready`
# event. The Electron app in desktop/ keeps shipping until the Qt app reaches
# parity.
#
#   cmake -S native -B build-native -G Ninja
#   cmake --build build-native
cmake_minimum_required(VERSION 3.21)

project(CloseNI VERSION 0.3.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

find_package(Qt6 6.8 REQUIRED COMPONENTS Core Gui Qml Quick QuickControls2)

qt_standard_project_setup(REQUIRES 6.8)

qt_add_executable(closeni
    src/main.cpp
)

qt_add_qml_module(closeni
    URI CloseNI
    VERSION 1.0
    QML_FILES
        qml/Main.qml
    SOURCES
        src/AgentProcess.h src/AgentProcess.cpp
        src/Paths.h src/Paths.cpp
)

# The QML module's build copy is build-native/CloseNI/, so the executable of
# the same name goes in bin/.
set_target_properties(closeni PROPERTIES
    OUTPUT_NAME CloseNI
    RUNTIME_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR}/bin
    MACOSX_BUNDLE TRUE
    MACOSX_BUNDLE_GUI_IDENTIFIER com.closeni.app
    MACOSX_BUNDLE_BUNDLE_VERSION ${PROJECT_VERSION}
    MACOSX_BUNDLE_SHORT_VERSION_STRING ${PROJECT_VERSION}
    WIN32_EXECUTABLE TRUE
)

# The generated QML type registration includes the headers by name.
target_include_directories(closeni PRIVATE src)

target_compile_definitions(closeni PRIVATE CLOSENI_VERSION="${PROJECT_VERSION}")

target_link_libraries(closeni PRIVATE
    Qt6::Core
    Qt6::Gui
    Qt6::Qml
    Qt6::Quick
    Qt6::QuickControls2
)
