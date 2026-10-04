cmake_minimum_required(VERSION 3.20)

project(iptvnator_live_caption LANGUAGES C CXX)

if(NOT DEFINED WHISPER_CPP_ROOT OR WHISPER_CPP_ROOT STREQUAL "")
    message(FATAL_ERROR "WHISPER_CPP_ROOT must point to the pinned whisper.cpp source tree")
endif()

if(NOT EXISTS "${WHISPER_CPP_ROOT}/CMakeLists.txt")
    message(FATAL_ERROR "WHISPER_CPP_ROOT does not contain whisper.cpp: ${WHISPER_CPP_ROOT}")
endif()

# Static Whisper/ggml linking keeps the CPU compatibility build self-contained.
# The optional CUDA variant also requires adjacent CUDA runtime/cuBLAS DLLs.
option(IPTVNATOR_WHISPER_CUDA "Build the optional NVIDIA caption worker" OFF)
set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
set(WHISPER_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(WHISPER_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(WHISPER_BUILD_SERVER OFF CACHE BOOL "" FORCE)
set(WHISPER_BUILD_IS_DEV OFF CACHE BOOL "" FORCE)
set(GGML_NATIVE OFF CACHE BOOL "" FORCE)
set(GGML_CUDA ${IPTVNATOR_WHISPER_CUDA} CACHE BOOL "" FORCE)
if(IPTVNATOR_WHISPER_CUDA)
    set(GGML_CUDA_FA_ALL_QUANTS OFF CACHE BOOL "" FORCE)
endif()
set(GGML_VULKAN OFF CACHE BOOL "" FORCE)
set(GGML_OPENCL OFF CACHE BOOL "" FORCE)
set(GGML_SYCL OFF CACHE BOOL "" FORCE)

add_subdirectory("${WHISPER_CPP_ROOT}" whisper-cpp EXCLUDE_FROM_ALL)

add_executable(iptvnator_whisper_helper whisper_worker.cpp)
target_compile_features(iptvnator_whisper_helper PRIVATE cxx_std_17)
target_link_libraries(iptvnator_whisper_helper PRIVATE whisper)
if(IPTVNATOR_WHISPER_CUDA)
    target_compile_definitions(iptvnator_whisper_helper PRIVATE IPTVNATOR_WHISPER_CUDA=1)
endif()

if(MSVC)
    target_compile_options(iptvnator_whisper_helper PRIVATE /utf-8 /EHsc)
endif()

set_target_properties(
    iptvnator_whisper_helper
    PROPERTIES
        RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin"
        RUNTIME_OUTPUT_DIRECTORY_RELEASE "${CMAKE_BINARY_DIR}/bin"
        RUNTIME_OUTPUT_DIRECTORY_RELWITHDEBINFO "${CMAKE_BINARY_DIR}/bin"
)
