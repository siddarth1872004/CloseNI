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
