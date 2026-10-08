# The native Qt app (design: docs/superpowers/specs/2026-10-08-native-qt-design.md,
# conventions: native/ARCHITECTURE.md).
#
#   cmake -S native -B build-native -G Ninja
#   cmake --build build-native
cmake_minimum_required(VERSION 3.21)

# The version has one home, the root package.json, which the agent and the
# release tag check also read.
file(READ ${CMAKE_CURRENT_SOURCE_DIR}/../package.json CLOSENI_PACKAGE_JSON)
string(JSON CLOSENI_PACKAGE_VERSION GET ${CLOSENI_PACKAGE_JSON} version)
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS ${CMAKE_CURRENT_SOURCE_DIR}/../package.json)

project(CloseNI VERSION ${CLOSENI_PACKAGE_VERSION} LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Only what the app uses: no Widgets, no web engine of any kind.
# QuickDialogs2 only for the native file and folder dialogs.
find_package(Qt6 6.8 REQUIRED COMPONENTS Core Gui Network Qml Quick QuickControls2 QuickDialogs2)

qt_standard_project_setup(REQUIRES 6.8)

# Globbed, so adding a file never touches this one. Paths are relative because
# qt_add_qml_module maps them to resource paths as written.
file(GLOB CLOSENI_SOURCES CONFIGURE_DEPENDS RELATIVE ${CMAKE_CURRENT_SOURCE_DIR}
    src/*.h src/*.cpp)
file(GLOB_RECURSE CLOSENI_QML CONFIGURE_DEPENDS RELATIVE ${CMAKE_CURRENT_SOURCE_DIR}
    qml/*.qml qml/*.mjs)
list(REMOVE_ITEM CLOSENI_SOURCES src/main.cpp)
# Small images the QML draws (theme texture tiles), served from the module.
file(GLOB_RECURSE CLOSENI_ASSETS CONFIGURE_DEPENDS RELATIVE ${CMAKE_CURRENT_SOURCE_DIR}
    qml/assets/*.png)

# Every file in qml/singletons/ (Theme, the stores) is a QML singleton.
file(GLOB CLOSENI_QML_SINGLETONS CONFIGURE_DEPENDS RELATIVE ${CMAKE_CURRENT_SOURCE_DIR}
    qml/singletons/*.qml)
if(CLOSENI_QML_SINGLETONS)
    set_source_files_properties(${CLOSENI_QML_SINGLETONS} PROPERTIES QT_QML_SINGLETON_TYPE TRUE)
endif()

# Platform code for the secret store (src/platform/), one file per system.
if(WIN32)
    set(CLOSENI_PLATFORM_SOURCES src/platform/SecretStore_win.cpp)
elseif(APPLE)
    set(CLOSENI_PLATFORM_SOURCES src/platform/SecretStore_mac.cpp)
else()
    set(CLOSENI_PLATFORM_SOURCES src/platform/SecretStore_linux.cpp)
endif()
foreach(f ${CLOSENI_PLATFORM_SOURCES})
    if(NOT EXISTS ${CMAKE_CURRENT_SOURCE_DIR}/${f})
        list(REMOVE_ITEM CLOSENI_PLATFORM_SOURCES ${f})
    endif()
endforeach()

# The app icon (made from build/icon.png by package/icons.mjs): embedded in the
# .exe through a resource script, and copied into the macOS bundle.
if(WIN32)
    set(CLOSENI_ICON package/closeni.rc)
elseif(APPLE)
    set(CLOSENI_ICON package/closeni.icns)
    set_source_files_properties(package/closeni.icns PROPERTIES MACOSX_PACKAGE_LOCATION Resources)
endif()

qt_add_executable(closeni
    src/main.cpp
    ${CLOSENI_PLATFORM_SOURCES}
    ${CLOSENI_ICON}
)

qt_add_qml_module(closeni
    URI CloseNI
    VERSION 1.0
    QML_FILES ${CLOSENI_QML}
    RESOURCES ${CLOSENI_ASSETS}
    SOURCES ${CLOSENI_SOURCES}
)

# The QML module's build copy is build-native/CloseNI/, so the executable of
# the same name goes in bin/.
set_target_properties(closeni PROPERTIES
    OUTPUT_NAME CloseNI
    RUNTIME_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR}/bin
    MACOSX_BUNDLE TRUE
    MACOSX_BUNDLE_GUI_IDENTIFIER com.siddarth.closeni
    MACOSX_BUNDLE_BUNDLE_NAME CloseNI
    MACOSX_BUNDLE_ICON_FILE closeni.icns
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
    Qt6::Network
    Qt6::Qml
    Qt6::Quick
    Qt6::QuickControls2
    Qt6::QuickDialogs2
)

if(WIN32)
    target_link_libraries(closeni PRIVATE crypt32)
elseif(APPLE)
    target_link_libraries(closeni PRIVATE "-framework Security" "-framework CoreFoundation")
else()
    # libsecret is opened at run time, so it is not a build dependency.
    target_link_libraries(closeni PRIVATE ${CMAKE_DL_LIBS})
endif()

# Qt Test suites for the services and the ported pure modules (native/tests/).
option(CLOSENI_TESTS "Build the native test suites" ON)
if(CLOSENI_TESTS AND EXISTS ${CMAKE_CURRENT_SOURCE_DIR}/tests/CMakeLists.txt)
    enable_testing()
    add_subdirectory(tests)
endif()
