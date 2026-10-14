// Directive scope reconstruction: #if is scope-transparent, #run is imperative.

#if AT_COMPILE_TIME {
    #run,stallable {
        set_build_options_dc(.{do_output=false});
        options := get_build_options();
        args := options.compile_time_command_line;
        if !generate_bindings(args) {
            compiler_set_workspace_status(.FAILED);
        }
    }
    conditional_global := 1;
} else {
    #import "System";

    main :: () {
        set_working_directory(path_strip_filename(get_path_of_running_executable()));
        args := get_command_line_arguments();
        if !generate_bindings(args) {
            exit(1);
        }
    }
}

#if ENABLE_EXTRA {
    extra_global := 2;
} else {
    fallback_global := 3;
}

#run {
    standalone_run_local := 4;
    {
        block_local := 5;
    }
    if true {
        if_local := 6;
    }
    for i: 0..2 {
        loop_local := i;
    }
}
after_run_global := 7;

computed_global := #run compute_value();
after_computed_global := 8;

// A #run payload may be a single declaration instead of a block; it is a
// compile-time local, not a global.
#run direct_run_local := 12;
#run,stallable direct_typed_local: int = 13;
#run direct_a, direct_b := 1, 2;
after_direct_global := 14;

PI_VALUE :: #run -> float {
    pi_local := 3.14;
    return pi_local;
}

RUN_RESULT :: #run () -> string {
    run_lambda_local := "x";
    return run_lambda_local;
}();

Conditional_Type :: struct {
    #if ENABLE_EXTRA {
        enabled_field: int;
    } else {
        fallback_field: int;
    }
}

compute_value :: () -> int {
    return 42;
}
