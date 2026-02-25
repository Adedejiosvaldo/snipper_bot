import { NextResponse } from "next/server";

export async function POST(request: Request) {
  try {
    const { password } = await request.json();
    const masterPassword = process.env.MASTER_PASSWORD;

    if (!masterPassword) {
      console.error("MASTER_PASSWORD is not set in environment variables");
      return NextResponse.json(
        { error: "Server configuration error" },
        { status: 500 },
      );
    }

    if (password === masterPassword) {
      const response = NextResponse.json({ success: true }, { status: 200 });

      // Set HTTP-only cookie
      response.cookies.set({
        name: "sniper_auth",
        value: "authenticated",
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        path: "/",
        maxAge: 60 * 60 * 24 * 7, // 1 week
      });

      return response;
    }

    return NextResponse.json({ error: "Invalid password" }, { status: 401 });
  } catch (error) {
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
