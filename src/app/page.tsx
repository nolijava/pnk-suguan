import { redirect } from "next/navigation";
import { currentUserOrNull } from "@/server/auth/guard";

export default async function Home() {
  const user = await currentUserOrNull();
  redirect(user ? "/teachers" : "/login");
}
