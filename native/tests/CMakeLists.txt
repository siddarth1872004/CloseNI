# Native test suites. Each block below is self-contained; add new suites as
# blocks of their own.

# --- js-modules: qml/js/*.mjs load and run in the QML engine ---------------
# Runs tst_jsmodules.qml with qmltestrunner from the Qt the app builds against.
find_program(CLOSENI_QMLTESTRUNNER qmltestrunner
    HINTS ${QT6_INSTALL_PREFIX}/${QT6_INSTALL_BINS} ${QT6_INSTALL_PREFIX}/bin
    NO_DEFAULT_PATH)
if(NOT CLOSENI_QMLTESTRUNNER)
    find_program(CLOSENI_QMLTESTRUNNER NAMES qmltestrunner6 qmltestrunner)
endif()
if(CLOSENI_QMLTESTRUNNER)
    add_test(NAME jsmodules
        COMMAND ${CLOSENI_QMLTESTRUNNER} -input ${CMAKE_CURRENT_SOURCE_DIR}/tst_jsmodules.qml)
    set_tests_properties(jsmodules PROPERTIES
        ENVIRONMENT "QT_QPA_PLATFORM=offscreen;QT_FORCE_STDERR_LOGGING=1")
else()
    message(STATUS "qmltestrunner not found: the jsmodules test is not registered")
endif()
# --- end js-modules ---------------------------------------------------------

# --- ui-foundation: the window loads and every theme and panel is clean -----
# CloseNI --self-test walks all themes x panels, the console, a toast and both
# modals offscreen, saves three screenshots, and exits 1 on any warning.
add_test(NAME ui_selftest
    COMMAND closeni --self-test ${CMAKE_CURRENT_BINARY_DIR}/ui-selftest)
set_tests_properties(ui_selftest PROPERTIES
    TIMEOUT 120
    ENVIRONMENT "QT_QPA_PLATFORM=offscreen;QT_FORCE_STDERR_LOGGING=1;CLOSENI_STORAGE=${CMAKE_CURRENT_BINARY_DIR}/ui-selftest/storage")
# --- end ui-foundation ------------------------------------------------------

# --- data-backend: Qt Test suites for the data services ---------------------
# Builds, files, git, GitHub, the library (skills, MCP), the Electron
# localStorage import and the secret store. Each suite runs against a scratch
# CLOSENI_STORAGE and never reaches the network: GitHub is a local server.
find_package(Qt6 REQUIRED COMPONENTS Test)

set(CLOSENI_DATA_SOURCES
    BuildRules BuildStore FilesService GitHubApi GitHubAuth GitHubSafe
    GitHubService GitRunner GitService LibraryService LocalStorageImport
    McpClient NodeCompat Paths Prefs SkillStore)
set(CLOSENI_DATA_FILES)
foreach(name ${CLOSENI_DATA_SOURCES})
    list(APPEND CLOSENI_DATA_FILES ../src/${name}.cpp ../src/${name}.h)
endforeach()
foreach(f ${CLOSENI_PLATFORM_SOURCES})
    list(APPEND CLOSENI_DATA_FILES ../${f})
endforeach()

add_library(closeni_data_test STATIC ${CLOSENI_DATA_FILES} ../src/Js.h ../src/SecretStore.h)
set_target_properties(closeni_data_test PROPERTIES AUTOMOC ON)
target_include_directories(closeni_data_test PUBLIC ../src)
target_link_libraries(closeni_data_test PUBLIC Qt6::Core Qt6::Network Qt6::Qml Qt6::Test)
if(WIN32)
    target_link_libraries(closeni_data_test PUBLIC crypt32)
elseif(APPLE)
    target_link_libraries(closeni_data_test PUBLIC "-framework Security" "-framework CoreFoundation")
else()
    target_link_libraries(closeni_data_test PUBLIC ${CMAKE_DL_LIBS})
endif()
if(NOT MSVC)
    target_compile_options(closeni_data_test PRIVATE -Wall -Wextra)
endif()

foreach(suite buildstore files git github library prefs_import secretstore)
    qt_add_executable(tst_${suite} tst_${suite}.cpp data_harness.h)
    set_target_properties(tst_${suite} PROPERTIES AUTOMOC ON)
    target_link_libraries(tst_${suite} PRIVATE closeni_data_test)
    if(NOT MSVC)
        target_compile_options(tst_${suite} PRIVATE -Wall -Wextra)
    endif()
    add_test(NAME ${suite} COMMAND tst_${suite})
    set_tests_properties(${suite} PROPERTIES
        TIMEOUT 120
        ENVIRONMENT "QT_QPA_PLATFORM=offscreen;QT_FORCE_STDERR_LOGGING=1;CLOSENI_REPO=${CMAKE_CURRENT_SOURCE_DIR}/../..")
endforeach()
# --- end data-backend -------------------------------------------------------

# --- ship-panels: the Test, Research and Ship panels in the real window ------
# Runs CloseNI --self-test-flow Ship against a scratch git workspace, a bare
# push remote and the GitHub mock, and checks what reached git and GitHub.
# The agent is found as the app finds it (CLOSENI_AGENT, else the checkout).
qt_add_executable(tst_ship_ui tst_ship_ui.cpp data_harness.h mock_github.h)
set_target_properties(tst_ship_ui PROPERTIES AUTOMOC ON)
target_link_libraries(tst_ship_ui PRIVATE closeni_data_test)
target_compile_definitions(tst_ship_ui PRIVATE
    CLOSENI_EXE="$<TARGET_FILE:closeni>"
    CLOSENI_SHIP_SHOTS="${CMAKE_CURRENT_BINARY_DIR}/ship-ui")
add_dependencies(tst_ship_ui closeni)
if(NOT MSVC)
    target_compile_options(tst_ship_ui PRIVATE -Wall -Wextra)
endif()
add_test(NAME ship_ui COMMAND tst_ship_ui)
set_tests_properties(ship_ui PROPERTIES TIMEOUT 300)
# --- end ship-panels --------------------------------------------------------

# --- settings: every Settings control, and the settings after a restart -----
# The self-test runs twice over one fresh storage. The first run changes every
# setting through the panel's own controls (qml/shell/SettingsCheck.qml); the
# second must find them all still set - "nothing to verify" fails it - before
# changing them again. mcp.json points at the fake MCP server when node is
# found, so the MCP context in the preamble is checked too.
find_program(CLOSENI_NODE node)
set(CLOSENI_SETTINGS_DIR ${CMAKE_CURRENT_BINARY_DIR}/settings-restart)
set(CLOSENI_SETTINGS_SEED ${CMAKE_CURRENT_BINARY_DIR}/settings-restart-mcp.json)
if(CLOSENI_NODE)
    get_filename_component(CLOSENI_FAKE_MCP
        ${CMAKE_CURRENT_SOURCE_DIR}/../../local-agent/test/fixtures/fake-mcp-server.js ABSOLUTE)
    file(WRITE ${CLOSENI_SETTINGS_SEED}
        "{\"servers\":{\"fake\":{\"command\":\"${CLOSENI_NODE}\",\"args\":[\"${CLOSENI_FAKE_MCP}\"]}},"
        "\"calls\":[{\"server\":\"fake\",\"tool\":\"search\",\"args\":{\"q\":\"hello\"}}]}")
else()
    file(WRITE ${CLOSENI_SETTINGS_SEED} "")
endif()
file(WRITE ${CMAKE_CURRENT_BINARY_DIR}/settings-restart-setup.cmake
    "file(REMOVE_RECURSE \"${CLOSENI_SETTINGS_DIR}\")\n"
    "file(MAKE_DIRECTORY \"${CLOSENI_SETTINGS_DIR}/storage\")\n"
    "file(COPY_FILE \"${CLOSENI_SETTINGS_SEED}\" \"${CLOSENI_SETTINGS_DIR}/storage/mcp.json\")\n")
add_test(NAME settings_restart_setup
    COMMAND ${CMAKE_COMMAND} -P ${CMAKE_CURRENT_BINARY_DIR}/settings-restart-setup.cmake)
set_tests_properties(settings_restart_setup PROPERTIES FIXTURES_SETUP settings_storage)
add_test(NAME settings_first_run
    COMMAND closeni --self-test ${CLOSENI_SETTINGS_DIR}/first)
add_test(NAME settings_after_restart
    COMMAND closeni --self-test ${CLOSENI_SETTINGS_DIR}/second)
set_tests_properties(settings_first_run settings_after_restart PROPERTIES
    TIMEOUT 120
    FIXTURES_REQUIRED settings_storage
    RESOURCE_LOCK settings_storage
    ENVIRONMENT "QT_QPA_PLATFORM=offscreen;QT_FORCE_STDERR_LOGGING=1;QML_DISABLE_DISK_CACHE=1;CLOSENI_STORAGE=${CLOSENI_SETTINGS_DIR}/storage")
set_tests_properties(settings_after_restart PROPERTIES
    DEPENDS settings_first_run
    FAIL_REGULAR_EXPRESSION "settings: nothing to verify")
# --- end settings -----------------------------------------------------------
