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
